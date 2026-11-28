import json
import unittest

import _path  # noqa: F401
from ai import models
from ai.models import PLANNER, EXECUTOR, CHECKER, SUMMARIZER, ROSTER
from ai.orchestrator import (
    Orchestrator,
    OrchestratorError,
    _extract_json,
    _validate_tasks,
)


def _reply(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


def _all_live() -> list[dict]:
    """A catalogue in which every default slug is present and free."""
    return [
        {
            "id": m.slug,
            "context_length": m.context,
            "pricing": {"prompt": "0", "completion": "0"},
        }
        for m in ROSTER
    ]


def _orch(*args, **kwargs) -> Orchestrator:
    """
    Build an Orchestrator pinned to the default roster.

    Without an injected catalogue the orchestrator resolves against the live
    OpenRouter API, which would make these tests network-dependent and would
    swap in whatever free model exists today (see ai/models.resolve_roster).
    Roster substitution itself is covered in test_models.py.
    """
    kwargs.setdefault("catalog_fetch", _all_live)
    return Orchestrator(*args, **kwargs)


class ExtractJsonTests(unittest.TestCase):
    def test_plain_object(self):
        self.assertEqual(_extract_json('{"a": 1}'), {"a": 1})

    def test_object_with_surrounding_prose(self):
        text = 'Sure, here you go:\n{"a": 1, "b": [1,2]}\nHope that helps!'
        self.assertEqual(_extract_json(text), {"a": 1, "b": [1, 2]})

    def test_markdown_fenced(self):
        text = '```json\n{"a": 1}\n```'
        self.assertEqual(_extract_json(text), {"a": 1})

    # OpenAI-Codex_web_ai: JSON strings may contain braces and escaped quotes.
    def test_braces_and_escaped_quotes_inside_string(self):
        value = {"summary": 'name } with "quotes" and unmatched {'}
        self.assertEqual(_extract_json("Here is the plan: " + json.dumps(value)), value)

    def test_no_json_raises(self):
        with self.assertRaises(OrchestratorError):
            _extract_json("no json here")

    def test_unbalanced_raises(self):
        with self.assertRaises(OrchestratorError):
            _extract_json('{"a": 1')

    # OpenAI-Codex_web_ai: accept unambiguous wrappers, reject nested or duplicate objects.
    def test_rejects_objects_wrapped_in_top_level_arrays(self):
        replies = (
            '[{"tasks":[]}]',
            'Here is the result: [{"tasks":[]}]',
            '```json\n[{"tasks":[]}]\n```',
            '["ignored ]", {"tasks":[]}]',
        )
        for reply in replies:
            with self.subTest(reply=reply), self.assertRaises(OrchestratorError):
                _extract_json(reply)

    def test_rejects_duplicate_json_keys_at_all_levels(self):
        replies = (
            '{"tasks":[],"tasks":[{"kind":"convert"}]}',
            '{"task":{"src":"one","src":"two"}}',
            '{"a":1,"\\u0061":2}',
        )
        for reply in replies:
            with self.subTest(reply=reply), self.assertRaises(OrchestratorError):
                _extract_json(reply)

    def test_rejects_extra_object_like_suffixes(self):
        replies = (
            '{"tasks":[]} trailing {"error":"synthetic"}',
            '{"tasks":[]} trailing {not json}',
            '{"tasks":[]} trailing }',
        )
        for reply in replies:
            with self.subTest(reply=reply), self.assertRaises(OrchestratorError):
                _extract_json(reply)

    def test_rejects_unbalanced_or_quoted_prefix(self):
        replies = (
            'unclosed [ here {"tasks":[]}',
            'unclosed " here {"tasks":[]}',
            '] here {"tasks":[]}',
        )
        for reply in replies:
            with self.subTest(reply=reply), self.assertRaises(OrchestratorError):
                _extract_json(reply)

    def test_safe_prose_markdown_and_braces_in_strings_remain_supported(self):
        value = {"summary": 'a "quote" and braces { }', "tasks": []}
        rendered = json.dumps(value)
        self.assertEqual(
            _extract_json("Plan [reference]: " + rendered + "\nDone."), value
        )
        self.assertEqual(_extract_json("```json\n" + rendered + "\n```"), value)

    # OpenAI-Codex_web_ai: reject nonstandard constants and unmatched trailing brackets.
    def test_rejects_nonfinite_json_constants_at_any_depth(self):
        replies = (
            '{"summary":NaN,"tasks":[]}',
            '{"summary":Infinity,"tasks":[]}',
            '{"summary":-Infinity,"tasks":[]}',
            '{"nested":{"value":NaN},"tasks":[]}',
            '{"nested":[Infinity],"tasks":[]}',
        )
        for reply in replies:
            with self.subTest(reply=reply):
                with self.assertRaises(OrchestratorError) as error:
                    _extract_json(reply)
                self.assertNotIn(reply, str(error.exception))

    def test_rejects_unmatched_closing_brackets_after_object(self):
        replies = (
            '{"tasks":[]}]',
            'Plan: {"tasks":[]} trailing ]',
            '{"tasks":[]} trailing [reference] ]',
        )
        for reply in replies:
            with self.subTest(reply=reply), self.assertRaises(OrchestratorError):
                _extract_json(reply)

    def test_keeps_nonfinite_words_and_balanced_prose_as_text(self):
        value = {"summary": "NaN Infinity -Infinity", "tasks": []}
        rendered = json.dumps(value)
        self.assertEqual(
            _extract_json("Plan: " + rendered + " trailing [reference]"), value
        )
        self.assertEqual(_extract_json(rendered + ' trailing "literal ]"'), value)
        self.assertEqual(_extract_json("```json\n" + rendered + "\n```"), value)

    # OpenAI-Codex_web_ai: JSON exponents must not overflow Python floats.
    def test_rejects_float_overflow_at_any_depth_without_echoing_content(self):
        replies = (
            '{"summary":"fictional-provider-content","number":1e999}',
            '{"summary":"fictional-provider-content","number":-1e999}',
            '{"nested":{"values":[2.5e+999]}}',
            '{"nested":[{"value":-3.4e1000}]}',
        )
        messages = set()
        for reply in replies:
            with self.subTest(reply=reply):
                with self.assertRaises(OrchestratorError) as error:
                    _extract_json(reply)
                message = str(error.exception)
                messages.add(message)
                self.assertNotIn("fictional-provider-content", message)
                self.assertNotIn(reply, message)
        self.assertEqual(len(messages), 1)

    def test_finite_scientific_notation_and_quoted_text_remain_valid(self):
        reply = '{"number":1.25e2,"small":-2.5e-3,"zero":0e999,"limit":1.7976931348623157e308,"text":"1e999"}'
        expected = {
            "number": 125.0,
            "small": -0.0025,
            "zero": 0.0,
            "limit": 1.7976931348623157e308,
            "text": "1e999",
        }
        self.assertEqual(_extract_json("Plan: " + reply + " trailing [note]"), expected)
        self.assertEqual(_extract_json("```json\n" + reply + "\n```"), expected)


class ValidateTasksTests(unittest.TestCase):
    def test_valid_download_passes(self):
        tasks, warnings = _validate_tasks(
            [
                {
                    "kind": "download",
                    "label": "x",
                    "url": "http://x",
                    "options": {"save_path": "out"},
                },
            ]
        )
        self.assertEqual(len(tasks), 1)
        self.assertEqual(warnings, [])
        self.assertEqual(tasks[0]["options"]["mode"], "video")  # default filled in
        self.assertEqual(tasks[0]["options"]["quality"], "best")

    def test_download_missing_url_dropped(self):
        tasks, warnings = _validate_tasks(
            [
                {"kind": "download", "label": "x", "options": {"save_path": "out"}},
            ]
        )
        self.assertEqual(tasks, [])
        self.assertIn("missing url", warnings[0])

    def test_download_missing_save_path_dropped(self):
        tasks, warnings = _validate_tasks(
            [
                {"kind": "download", "label": "x", "url": "http://x", "options": {}},
            ]
        )
        self.assertEqual(tasks, [])
        self.assertIn("missing save_path", warnings[0])

    def test_bad_format_clamped_not_dropped(self):
        tasks, warnings = _validate_tasks(
            [
                {
                    "kind": "download",
                    "label": "x",
                    "url": "http://x",
                    "options": {"save_path": "out", "video_fmt": "totally-fake-format"},
                },
            ]
        )
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["options"]["video_fmt"], "mp4")  # clamped to default
        self.assertTrue(any("video_fmt" in warning for warning in warnings))

    def test_each_invalid_option_is_explained(self):
        tasks, warnings = _validate_tasks(
            [
                {
                    "kind": "download",
                    "label": "clip",
                    "url": "http://x",
                    "options": {
                        "save_path": "out",
                        "mode": "wrong",
                        "video_fmt": "bad",
                        "audio_fmt": "bad",
                        "quality": "bad",
                        "browser": "bad",
                    },
                }
            ]
        )
        self.assertEqual(len(tasks), 1)
        for field in ("mode", "video_fmt", "audio_fmt", "quality", "browser"):
            with self.subTest(field=field):
                self.assertTrue(any(field in warning for warning in warnings))

    def test_valid_convert_passes(self):
        tasks, warnings = _validate_tasks(
            [
                {
                    "kind": "convert",
                    "label": "c",
                    "src_path": "a.mkv",
                    "dst_path": "a.mp4",
                },
            ]
        )
        self.assertEqual(len(tasks), 1)
        self.assertEqual(warnings, [])

    def test_ai_overwrite_request_is_downgraded_and_explained(self):
        tasks, warnings = _validate_tasks(
            [
                {
                    "kind": "convert",
                    "label": "c",
                    "src_path": "a.mkv",
                    "dst_path": "a.mp4",
                    "conflict_policy": "overwrite",
                }
            ]
        )
        self.assertEqual(tasks[0]["conflict_policy"], "rename")
        self.assertTrue(any("overwrite" in warning.lower() for warning in warnings))

    # OpenAI-Codex_web_ai: warn about untracked provenance without inferring a dependency.
    def test_later_convert_warns_even_when_sources_appear_unrelated(self):
        tasks, warnings = _validate_tasks(
            [
                {
                    "kind": "download",
                    "url": "http://x",
                    "options": {"save_path": "new-downloads"},
                },
                {
                    "kind": "convert",
                    "src_path": "unrelated-existing.mkv",
                    "dst_path": "out.mp4",
                },
                {
                    "kind": "convert",
                    "src_path": "another.mkv",
                    "dst_path": "another.mp4",
                },
            ]
        )
        self.assertEqual(len(tasks), 3)
        provenance = [
            warning for warning in warnings if "not tracked" in warning.lower()
        ]
        self.assertEqual(len(provenance), 1)
        self.assertIn("download fails", provenance[0].lower())
        self.assertIn("existing file", provenance[0].lower())

    def test_convert_before_download_has_no_provenance_warning(self):
        tasks, warnings = _validate_tasks(
            [
                {"kind": "convert", "src_path": "old.mkv", "dst_path": "out.mp4"},
                {
                    "kind": "download",
                    "url": "http://x",
                    "options": {"save_path": "out"},
                },
            ]
        )
        self.assertEqual(len(tasks), 2)
        self.assertEqual(warnings, [])

    def test_dropped_download_does_not_trigger_provenance_warning(self):
        tasks, warnings = _validate_tasks(
            [
                {"kind": "download", "options": {"save_path": "out"}},
                {"kind": "convert", "src_path": "old.mkv", "dst_path": "out.mp4"},
            ]
        )
        self.assertEqual(len(tasks), 1)
        self.assertFalse(any("not tracked" in warning.lower() for warning in warnings))

    def test_unknown_kind_dropped(self):
        tasks, warnings = _validate_tasks([{"kind": "frobnicate"}])
        self.assertEqual(tasks, [])
        self.assertIn("unknown task kind", warnings[0])

    def test_non_list_input_is_empty(self):
        tasks, warnings = _validate_tasks(None)
        self.assertEqual((tasks, warnings), ([], []))

    def test_audio_bitrate_plan_values(self):
        for supplied, expected, warns in (
            ("0320", "320", False),
            ("0", "192", True),
            (128, "192", True),
            (None, "192", True),
        ):
            with self.subTest(bitrate=supplied):
                task = {
                    "kind": "download",
                    "url": "https://example.com/media",
                    "options": {
                        "save_path": "out",
                        "mode": "audio",
                        "bitrate": supplied,
                    },
                }
                clean, warnings = _validate_tasks([task])
                self.assertEqual(clean[0]["options"]["bitrate"], expected)
                self.assertEqual(bool(warnings), warns)
        clean, warnings = _validate_tasks(
            [
                {
                    "kind": "download",
                    "url": "https://example.com/media",
                    "options": {"save_path": "out"},
                }
            ]
        )
        self.assertEqual(clean[0]["options"]["bitrate"], "192")
        self.assertEqual(warnings, [])


class OrchestratorInitTests(unittest.TestCase):
    def test_missing_api_key_raises(self):
        with self.assertRaises(OrchestratorError):
            Orchestrator("")
        with self.assertRaises(OrchestratorError):
            Orchestrator("   ")


class PlanPipelineTests(unittest.TestCase):
    def setUp(self):
        models.clear_cache()

    def tearDown(self):
        models.clear_cache()

    def _make(self, planner=None, executor=None, checker=None, log=None):
        calls = []

        def transport(url, payload, api_key):
            calls.append(payload["model"])
            self.assertEqual(api_key, "test-key")
            model = payload["model"]
            if model == PLANNER.slug:
                return _reply(planner)
            if model == EXECUTOR.slug:
                return _reply(executor)
            if model == CHECKER.slug:
                return _reply(checker)
            raise AssertionError(f"unexpected model called: {model}")

        orch = _orch("test-key", transport=transport, log_cb=log)
        return orch, calls

    def test_happy_path(self):
        planner = json.dumps(
            {
                "summary": "download one video",
                "tasks": [
                    {
                        "kind": "download",
                        "label": "vid",
                        "url": "http://x",
                        "options": {"save_path": "out"},
                    }
                ],
            }
        )
        executor = planner  # executor just passes it through unchanged
        checker = json.dumps({"ok": True, "warnings": []})

        logs = []
        orch, calls = self._make(
            planner,
            executor,
            checker,
            log=lambda lvl, key, **fmt: logs.append((lvl, key, fmt)),
        )
        result = orch.plan("download http://x")

        self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug, CHECKER.slug])
        self.assertEqual(result["summary"], "download one video")
        self.assertEqual(len(result["tasks"]), 1)
        self.assertEqual(result["warnings"], [])
        # log sequence observed
        self.assertEqual(
            [k for _, k, _ in logs],
            [
                "log_ai_planning_start",
                "log_ai_executing",
                "log_ai_checking",
                "log_ai_plan_ready",
            ],
        )
        self.assertEqual(logs[-1][2], {"n": 1})

    def test_mixed_plan_returns_non_blocking_provenance_warning(self):
        planner = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {
                        "kind": "download",
                        "url": "http://x",
                        "options": {"save_path": "out"},
                    },
                    {"kind": "convert", "src_path": "old.mkv", "dst_path": "out.mp4"},
                ],
            }
        )
        orch, _ = self._make(planner, planner, json.dumps({"ok": True, "warnings": []}))
        result = orch.plan("download then convert")
        self.assertEqual(len(result["tasks"]), 2)
        self.assertTrue(
            any("not tracked" in warning.lower() for warning in result["warnings"])
        )

    def test_checker_flags_warning_but_plan_still_returned(self):
        planner = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {
                        "kind": "convert",
                        "label": "c",
                        "src_path": "a.mkv",
                        "dst_path": "a.mp4",
                    },
                ],
            }
        )
        checker = json.dumps({"ok": False, "warnings": ["destination looks unusual"]})
        orch, _ = self._make(planner, planner, checker)
        result = orch.plan("convert a.mkv")
        self.assertEqual(len(result["tasks"]), 1)
        self.assertIn("destination looks unusual", result["warnings"])

    def test_checker_malformed_reply_is_advisory_not_fatal(self):
        planner = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {
                        "kind": "convert",
                        "label": "c",
                        "src_path": "a.mkv",
                        "dst_path": "a.mp4",
                    },
                ],
            }
        )
        orch, _ = self._make(planner, planner, checker="not json at all")
        result = orch.plan("convert a.mkv")
        self.assertEqual(len(result["tasks"]), 1)  # plan still returned
        self.assertTrue(
            any("checker" in warning.lower() for warning in result["warnings"])
        )

    def test_checker_negative_verdict_is_visible_without_model_warning(self):
        planner = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {
                        "kind": "convert",
                        "label": "c",
                        "src_path": "a.mkv",
                        "dst_path": "a.mp4",
                    },
                ],
            }
        )
        orch, _ = self._make(
            planner, planner, checker=json.dumps({"ok": False, "warnings": []})
        )
        result = orch.plan("convert a.mkv")
        self.assertEqual(len(result["tasks"]), 1)
        self.assertTrue(
            any("checker" in warning.lower() for warning in result["warnings"])
        )

    def test_checker_invalid_warning_shape_is_reported(self):
        planner = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {
                        "kind": "convert",
                        "label": "c",
                        "src_path": "a.mkv",
                        "dst_path": "a.mp4",
                    },
                ],
            }
        )
        orch, _ = self._make(
            planner, planner, checker=json.dumps({"ok": True, "warnings": "bad"})
        )
        result = orch.plan("convert a.mkv")
        self.assertTrue(
            any("checker" in warning.lower() for warning in result["warnings"])
        )

    def test_checker_unexpected_transport_failure_is_visible(self):
        planner = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {
                        "kind": "convert",
                        "label": "c",
                        "src_path": "a.mkv",
                        "dst_path": "a.mp4",
                    },
                ],
            }
        )

        def transport(_url, payload, _api_key):
            if payload["model"] == CHECKER.slug:
                raise RuntimeError("checker transport failed")
            return _reply(planner)

        result = _orch("test-key", transport=transport).plan("convert a.mkv")
        self.assertEqual(len(result["tasks"]), 1)
        self.assertTrue(
            any("checker" in warning.lower() for warning in result["warnings"])
        )

    def test_planner_malformed_json_raises(self):
        orch, _ = self._make(planner="no json", executor="{}", checker="{}")
        with self.assertRaises(OrchestratorError):
            orch.plan("do something")

    def test_guard_drops_invalid_task_end_to_end(self):
        planner = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {
                        "kind": "download",
                        "label": "bad",
                        "options": {"save_path": "out"},
                    },  # no url
                ],
            }
        )
        orch, _ = self._make(planner, planner, json.dumps({"ok": True, "warnings": []}))
        result = orch.plan("do something vague")
        self.assertEqual(result["tasks"], [])
        self.assertTrue(any("missing url" in w for w in result["warnings"]))

    # OpenAI-Codex_web_ai: reject error envelopes and malformed task lists.
    def test_planner_error_or_invalid_tasks_rejected_without_provider_content(self):
        secret = "synthetic-provider-private"  # noqa: S105
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        invalid = (
            {"summary": secret, "tasks": [], "error": secret},
            {"summary": secret, "tasks": [], "error": None},
            {"summary": secret},
            {"summary": secret, "tasks": None},
            {"summary": secret, "tasks": {}},
            {"summary": secret, "tasks": secret},
        )
        for reply in invalid:
            with self.subTest(reply=reply):
                orch, calls = self._make(json.dumps(reply), valid, "{}")
                with self.assertRaises(OrchestratorError) as error:
                    orch.plan("convert a.mkv")
                self.assertIn("planner", str(error.exception).lower())
                self.assertNotIn(secret, str(error.exception))
                self.assertEqual(calls, [PLANNER.slug])

    def test_executor_error_or_invalid_tasks_rejected_without_provider_content(self):
        secret = "synthetic-provider-private"  # noqa: S105
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        invalid = (
            {"summary": secret, "tasks": [], "error": secret},
            {"summary": secret, "tasks": [], "error": None},
            {"summary": secret},
            {"summary": secret, "tasks": None},
            {"summary": secret, "tasks": {}},
            {"summary": secret, "tasks": secret},
        )
        for reply in invalid:
            with self.subTest(reply=reply):
                orch, calls = self._make(valid, json.dumps(reply), "{}")
                with self.assertRaises(OrchestratorError) as error:
                    orch.plan("convert a.mkv")
                self.assertIn("executor", str(error.exception).lower())
                self.assertNotIn(secret, str(error.exception))
                self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug])

    def test_checker_error_is_advisory_even_when_ok_true(self):
        secret = "synthetic-provider-private"  # noqa: S105
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        for provider_error in (secret, None):
            with self.subTest(provider_error=provider_error):
                logs = []
                checker = json.dumps(
                    {"ok": True, "warnings": [], "error": provider_error}
                )
                orch, _ = self._make(
                    valid,
                    valid,
                    checker,
                    log=lambda level, key, **fmt: logs.append((level, key, fmt)),
                )
                result = orch.plan("convert a.mkv")
                self.assertEqual(len(result["tasks"]), 1)
                self.assertTrue(
                    any("checker" in warning.lower() for warning in result["warnings"])
                )
                self.assertNotIn(secret, json.dumps(result))
                self.assertNotIn(secret, json.dumps(logs))

    def test_empty_task_lists_remain_valid(self):
        empty = json.dumps({"summary": "no tasks", "tasks": []})
        orch, calls = self._make(empty, empty, "{}")
        result = orch.plan("no actionable task")
        self.assertEqual(result["tasks"], [])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug])

    # OpenAI-Codex_web_ai: an empty draft cannot become executable work.
    def test_executor_cannot_invent_tasks_when_planner_draft_is_empty(self):
        secret = "fictional-provider-content"  # noqa: S105
        draft = json.dumps({"summary": secret, "tasks": []})
        outputs = (
            {
                "summary": secret,
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            },
            {"summary": secret, "tasks": [None]},
        )
        for output in outputs:
            with self.subTest(output=output):
                logs = []
                orch, calls = self._make(
                    draft,
                    json.dumps(output),
                    "{}",
                    log=lambda level, key, **fmt: logs.append((level, key, fmt)),
                )
                with self.assertRaises(OrchestratorError) as error:
                    orch.plan("convert a.mkv")
                self.assertIn("empty", str(error.exception).lower())
                self.assertNotIn(secret, str(error.exception))
                self.assertNotIn(secret, json.dumps(logs))
                self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug])

    def test_executor_can_return_empty_tasks_from_nonempty_draft(self):
        draft = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        empty = json.dumps({"summary": "none", "tasks": []})
        orch, calls = self._make(draft, empty, "{}")
        result = orch.plan("convert a.mkv")
        self.assertEqual(result["tasks"], [])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug])

    # OpenAI-Codex_web_ai: reject ambiguous model framing before later roles run.
    def test_array_wrapped_planner_reply_does_not_reach_executor(self):
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        orch, calls = self._make("[" + valid + "]", valid, "{}")
        with self.assertRaises(OrchestratorError):
            orch.plan("convert a.mkv")
        self.assertEqual(calls, [PLANNER.slug])

    def test_duplicate_executor_keys_do_not_reach_checker(self):
        secret = "fictional-provider-content"  # noqa: S105
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        duplicate = (
            '{"tasks":[],"tasks":[{"kind":"convert","src_path":"a","dst_path":"b"}],"summary":"'
            + secret
            + '"}'
        )
        orch, calls = self._make(valid, duplicate, "{}")
        with self.assertRaises(OrchestratorError) as error:
            orch.plan("convert a.mkv")
        self.assertNotIn(secret, str(error.exception))
        self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug])

    # OpenAI-Codex_web_ai: reject nonstandard constants and trailing brackets before later roles.
    def test_nonfinite_planner_reply_does_not_reach_executor(self):
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        orch, calls = self._make('{"summary":NaN,"tasks":[]}', valid, "{}")
        with self.assertRaises(OrchestratorError):
            orch.plan("convert a.mkv")
        self.assertEqual(calls, [PLANNER.slug])

    def test_unmatched_executor_bracket_does_not_reach_checker(self):
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        orch, calls = self._make(valid, valid + "]", "{}")
        with self.assertRaises(OrchestratorError):
            orch.plan("convert a.mkv")
        self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug])

    # OpenAI-Codex_web_ai: never forward overflowed planner or executor JSON.
    def test_float_overflow_planner_stops_before_executor(self):
        secret = "fictional-provider-content"  # noqa: S105
        invalid = '{"summary":"' + secret + '","tasks":[],"score":1e999}'
        valid = json.dumps({"summary": "s", "tasks": []})
        orch, calls = self._make(invalid, valid, "{}")
        with self.assertRaises(OrchestratorError) as error:
            orch.plan("synthetic request")
        self.assertNotIn(secret, str(error.exception))
        self.assertEqual(calls, [PLANNER.slug])

    def test_float_overflow_executor_stops_before_checker(self):
        secret = "fictional-provider-content"  # noqa: S105
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        invalid = '{"summary":"' + secret + '","tasks":[],"score":-1e999}'
        orch, calls = self._make(valid, invalid, "{}")
        with self.assertRaises(OrchestratorError) as error:
            orch.plan("synthetic request")
        self.assertNotIn(secret, str(error.exception))
        self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug])

    def test_float_overflow_checker_is_advisory_without_echoing_content(self):
        secret = "fictional-provider-content"  # noqa: S105
        valid = json.dumps(
            {
                "summary": "s",
                "tasks": [
                    {"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"},
                ],
            }
        )
        checker = '{"ok":true,"warnings":[],"score":1e999,"detail":"' + secret + '"}'
        orch, calls = self._make(valid, valid, checker)
        result = orch.plan("synthetic request")
        self.assertEqual(len(result["tasks"]), 1)
        self.assertTrue(
            any("checker" in warning.lower() for warning in result["warnings"])
        )
        self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(calls, [PLANNER.slug, EXECUTOR.slug, CHECKER.slug])


class SummarizeTests(unittest.TestCase):
    def setUp(self):
        models.clear_cache()

    def tearDown(self):
        models.clear_cache()

    def test_summarize_calls_summarizer(self):
        def transport(url, payload, api_key):
            self.assertEqual(payload["model"], SUMMARIZER.slug)
            return _reply("2 of 3 tasks succeeded.")

        orch = _orch("k", transport=transport)
        out = orch.summarize([{"label": "a", "status": "done"}])
        self.assertEqual(out, "2 of 3 tasks succeeded.")


class TransportErrorTests(unittest.TestCase):
    def setUp(self):
        models.clear_cache()

    def tearDown(self):
        models.clear_cache()

    def test_transport_raising_propagates(self):
        def boom(url, payload, api_key):
            raise OrchestratorError("network down")

        orch = _orch("k", transport=boom)
        with self.assertRaises(OrchestratorError):
            orch.plan("anything")

    def test_unexpected_response_shape_raises(self):
        def weird(url, payload, api_key):
            return {"nope": True}

        orch = _orch("k", transport=weird)
        with self.assertRaises(OrchestratorError):
            orch.plan("anything")

    def test_unexpected_response_does_not_echo_provider_body(self):
        def weird(_url, _payload, _api_key):
            return {"unexpected": "sensitive response content"}

        orch = _orch("k", transport=weird)
        with self.assertRaises(OrchestratorError) as error:
            orch.plan("anything")
        self.assertNotIn("sensitive response content", str(error.exception))

    # OpenAI-Codex_web_ai: HTTP diagnostics use only status and known retry markers.
    def _probe_http_failure(self, status, body, secret, short_read=None):
        import io
        import traceback
        import urllib.error
        from unittest.mock import patch
        from ai.orchestrator import _default_transport

        class RecordingStream(io.BytesIO):
            def __init__(self, data):
                super().__init__(data)
                self.requests = []
                self.total_read = 0

            def read(self, size=-1):
                self.requests.append(size)
                actual = (
                    min(size, short_read)
                    if short_read is not None and size >= 0
                    else size
                )
                data = super().read(actual)
                self.total_read += len(data)
                return data

        stream = RecordingStream(body.encode("utf-8"))

        def fake_urlopen(request, timeout):
            raise urllib.error.HTTPError(
                request.full_url,
                status,
                "private synthetic reason " + secret,
                {},
                stream,
            )

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            try:
                _default_transport("https://example.invalid", {}, secret)
            except OrchestratorError as error:
                message = str(error)
                formatted = "".join(
                    traceback.format_exception(type(error), error, error.__traceback__)
                )
            else:
                self.fail("expected an HTTP error")
        return message, formatted, stream

    def test_http_error_hides_body_and_formatted_exception_chain(self):
        secret = "fictional-http-test-key-only"  # noqa: S105
        message, formatted, _stream = self._probe_http_failure(
            429, "private synthetic response " + secret, secret
        )
        self.assertIn("HTTP 429", message)
        self.assertNotIn(secret, message)
        self.assertNotIn(secret, formatted)
        self.assertNotIn("private synthetic response", message)
        self.assertNotIn("private synthetic reason", formatted)

    def test_http_error_exposes_only_fixed_retry_markers(self):
        secret = "fictional-http-test-key-only"  # noqa: S105
        markers = (
            "HTTP 404",
            "HTTP 400",
            "not a valid model",
            "No endpoints found",
            "No allowed providers",
        )
        for marker in markers:
            with self.subTest(marker=marker):
                message, formatted, _stream = self._probe_http_failure(
                    503, "private synthetic response " + secret + " " + marker, secret
                )
                self.assertIn("HTTP 503", message)
                self.assertIn(marker, message)
                self.assertNotIn(secret, message + formatted)
                self.assertNotIn("private synthetic response", message + formatted)

    def test_http_error_retry_classification_is_preserved(self):
        import io
        import urllib.error
        from unittest.mock import patch
        from ai.orchestrator import _default_transport

        secret = "fictional-http-test-key-only"  # noqa: S105
        cases = (
            (400, "", True),
            (404, "", True),
            (429, "", False),
            (503, "", False),
            (503, "not a valid model", True),
            (503, "No endpoints found", True),
            (503, "No allowed providers", True),
        )
        for status, marker, should_retry in cases:
            with self.subTest(status=status, marker=marker):
                models.clear_cache()
                calls = []
                body = ("private synthetic response " + secret + " " + marker).encode(
                    "utf-8"
                )

                def fake_urlopen(request, timeout):
                    calls.append(1)
                    if len(calls) == 1:
                        raise urllib.error.HTTPError(
                            request.full_url, status, "synthetic", {}, io.BytesIO(body)
                        )
                    return io.BytesIO(
                        json.dumps(_reply("fallback succeeded")).encode("utf-8")
                    )

                with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                    orch = _orch(secret, transport=_default_transport)
                    if should_retry:
                        self.assertEqual(
                            orch._call(PLANNER, "system", "request"),
                            "fallback succeeded",
                        )
                        self.assertEqual(len(calls), 2)
                    else:
                        with self.assertRaises(OrchestratorError) as error:
                            orch._call(PLANNER, "system", "request")
                        self.assertIn(f"HTTP {status}", str(error.exception))
                        self.assertEqual(len(calls), 1)

    def test_http_error_read_is_bounded_with_short_reads(self):
        secret = "fictional-http-test-key-only"  # noqa: S105
        body = "No endpoints found " + secret + "x" * 5000
        message, formatted, stream = self._probe_http_failure(
            503, body, secret, short_read=7
        )
        self.assertTrue(stream.requests)
        self.assertTrue(all(0 <= size <= 1200 for size in stream.requests))
        self.assertEqual(stream.total_read, 1200)
        self.assertTrue(stream.closed)
        self.assertIn("No endpoints found", message)
        self.assertNotIn(secret, message + formatted)

    def test_http_error_retry_marker_respects_unicode_character_limit(self):
        secret = "fictional-http-test-key-only"  # noqa: S105
        marker = "not a valid model"
        visible, visible_trace, _ = self._probe_http_failure(
            503, "😀" * 283 + marker + secret, secret, short_read=7
        )
        outside, outside_trace, _ = self._probe_http_failure(
            503, "😀" * 284 + marker + secret, secret, short_read=7
        )
        self.assertIn(marker, visible)
        self.assertNotIn(marker, outside)
        self.assertNotIn(secret, visible + outside + visible_trace + outside_trace)

    # OpenAI-Codex_web_ai: never expose raw URL or timeout reasons.
    def _probe_network_failure(self, failure, secret):
        import traceback
        from unittest.mock import patch
        from ai.orchestrator import _default_transport

        with patch("urllib.request.urlopen", side_effect=failure):
            try:
                _default_transport("https://example.invalid", {}, secret)
            except Exception as error:
                self.assertIsInstance(error, OrchestratorError)
                message = str(error)
                formatted = "".join(
                    traceback.format_exception(type(error), error, error.__traceback__)
                )
            else:
                self.fail("expected a network error")
        return message, formatted

    def test_url_error_hides_reason_and_traceback_but_keeps_retry_markers(self):
        import urllib.error

        secret = "fictional-url-test-key-only"  # noqa: S105
        markers = (
            "",
            "HTTP 404",
            "HTTP 400",
            "not a valid model",
            "No endpoints found",
            "No allowed providers",
        )
        for marker in markers:
            with self.subTest(marker=marker):
                reason = "private synthetic reason " + secret + " " + marker
                message, formatted = self._probe_network_failure(
                    urllib.error.URLError(reason), secret
                )
                self.assertIn("request failed", message)
                if marker:
                    self.assertIn(marker, message)
                self.assertNotIn(secret, message + formatted)
                self.assertNotIn("private synthetic reason", message + formatted)

    def test_timeout_error_hides_reason_and_traceback(self):
        secret = "fictional-timeout-test-key-only"  # noqa: S105
        message, formatted = self._probe_network_failure(
            TimeoutError("private synthetic timeout " + secret), secret
        )
        self.assertIn("timed out", message)
        self.assertNotIn(secret, message + formatted)
        self.assertNotIn("private synthetic timeout", message + formatted)

    def test_url_error_preserves_retry_and_timeout_never_retries(self):
        import io
        import urllib.error
        from unittest.mock import patch
        from ai.orchestrator import _default_transport

        secret = "fictional-retry-test-key-only"  # noqa: S105
        cases = [
            ("url", marker, True)
            for marker in (
                "HTTP 404",
                "HTTP 400",
                "not a valid model",
                "No endpoints found",
                "No allowed providers",
            )
        ]
        cases += [("url", "", False), ("timeout", "No endpoints found", False)]
        for kind, marker, should_retry in cases:
            with self.subTest(kind=kind, marker=marker):
                models.clear_cache()
                calls = []

                def fake_urlopen(request, timeout):
                    calls.append(1)
                    if len(calls) == 1:
                        reason = "private synthetic reason " + secret + " " + marker
                        if kind == "url":
                            raise urllib.error.URLError(reason)
                        raise TimeoutError(reason)
                    return io.BytesIO(
                        json.dumps(_reply("fallback succeeded")).encode("utf-8")
                    )

                with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                    orch = _orch(secret, transport=_default_transport)
                    if should_retry:
                        self.assertEqual(
                            orch._call(PLANNER, "system", "request"),
                            "fallback succeeded",
                        )
                        self.assertEqual(len(calls), 2)
                    else:
                        try:
                            orch._call(PLANNER, "system", "request")
                        except Exception as error:
                            self.assertIsInstance(error, OrchestratorError)
                            self.assertNotIn(secret, str(error))
                        else:
                            self.fail("expected a network error")
                        self.assertEqual(len(calls), 1)

    def test_sidecar_ai_responses_and_events_hide_network_error_reasons(self):
        import engine_sidecar as sc
        import urllib.error
        from unittest.mock import patch

        secret = "fictional-sidecar-test-key-only"  # noqa: S105
        for kind in ("url", "timeout"):
            for command in ("ai_plan", "ai_summarize"):
                with self.subTest(kind=kind, command=command):
                    models.clear_cache()
                    events = []
                    args = (
                        {"api_key": secret, "prompt": "sample"}
                        if command == "ai_plan"
                        else {
                            "api_key": secret,
                            "results": [],
                        }
                    )

                    def fake_urlopen(_request, timeout):
                        reason = "private synthetic reason " + secret
                        if kind == "url":
                            raise urllib.error.URLError(reason)
                        raise TimeoutError(reason)

                    def factory(key, **kwargs):
                        return Orchestrator(key, catalog_fetch=_all_live, **kwargs)

                    with (
                        patch.object(sc, "Orchestrator", side_effect=factory),  # \\
                        patch("urllib.request.urlopen", side_effect=fake_urlopen),
                    ):
                        result = sc.Sidecar(events.append).dispatch(
                            {
                                "id": command,
                                "cmd": command,
                                "args": args,
                            }
                        )
                    self.assertFalse(result["ok"])
                    self.assertNotIn(secret, json.dumps(result))
                    self.assertNotIn(secret, json.dumps(events))
                    self.assertTrue(
                        any(event.get("key") == "log_ai_plan_error" for event in events)
                    )

    # OpenAI-Codex_web_ai: reject control characters and hide unexpected transport failures.
    def test_key_control_characters_are_rejected_during_initialization(self):
        head, tail = "fictional-head-only", "fictional-tail-only"
        for codepoint in (0, 9, 10, 13, 31, 127, 128, 133, 159):
            with self.subTest(codepoint=codepoint):
                key = head + chr(codepoint) + tail
                try:
                    Orchestrator(key, catalog_fetch=_all_live)
                except Exception as error:
                    self.assertIsInstance(error, OrchestratorError)
                    self.assertIn("control", str(error).lower())
                    self.assertNotIn(head, str(error))
                    self.assertNotIn(tail, str(error))
                else:
                    self.fail("expected control characters to be rejected")
        self.assertIsInstance(
            Orchestrator("fictional-valid-key", catalog_fetch=_all_live), Orchestrator
        )

    def test_default_transport_rejects_controls_before_creating_request(self):
        from unittest.mock import patch
        from ai.orchestrator import _default_transport

        key = "fictional-head-only" + chr(10) + "fictional-tail-only"
        with patch(
            "urllib.request.Request",
            side_effect=AssertionError("request must not be created"),
        ):
            try:
                _default_transport("https://example.invalid", {}, key)
            except Exception as error:
                self.assertIsInstance(error, OrchestratorError)
                self.assertIn("control", str(error).lower())
                self.assertNotIn("fictional-head-only", str(error))
                self.assertNotIn("fictional-tail-only", str(error))
            else:
                self.fail("expected control characters to be rejected")

    def test_default_transport_hides_unexpected_construction_and_open_errors(self):
        import traceback
        from unittest.mock import patch
        from ai.orchestrator import _default_transport

        secret = "fictional-unexpected-key-only"  # noqa: S105
        for target in ("urllib.request.Request", "urllib.request.urlopen"):
            with self.subTest(target=target), patch(
                target, side_effect=ValueError("private reason " + secret)
            ):
                try:
                    _default_transport("https://example.invalid", {}, secret)
                except Exception as error:
                    self.assertIsInstance(error, OrchestratorError)
                    formatted = "".join(
                        traceback.format_exception(
                            type(error), error, error.__traceback__
                        )
                    )
                    self.assertIn("request failed", str(error).lower())
                    self.assertNotIn(secret, str(error) + formatted)
                    self.assertNotIn("private reason", str(error) + formatted)
                else:
                    self.fail("expected an unexpected transport error")

    def test_default_transport_valid_key_still_succeeds(self):
        import io
        from unittest.mock import patch
        from ai.orchestrator import _default_transport

        seen = []

        def fake_urlopen(request, timeout):
            seen.append(request.get_header("Authorization"))
            return io.BytesIO(b'{"result": "ok"}')

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = _default_transport(
                "https://example.invalid", {}, "fictional-valid-key"
            )
        self.assertEqual(result, {"result": "ok"})
        self.assertEqual(seen, ["Bearer fictional-valid-key"])

    def test_sidecar_ai_errors_hide_invalid_key_and_unexpected_failures(self):
        import engine_sidecar as sc
        from unittest.mock import patch

        head, tail = "fictional-head-only", "fictional-tail-only"
        for kind in ("control", "unexpected"):
            for command in ("ai_plan", "ai_summarize"):
                with self.subTest(kind=kind, command=command):
                    models.clear_cache()
                    key = head + chr(10) + tail if kind == "control" else head + tail
                    events = []
                    args = (
                        {"api_key": key, "prompt": "sample"}
                        if command == "ai_plan"
                        else {
                            "api_key": key,
                            "results": [],
                        }
                    )

                    def factory(value, **kwargs):
                        return Orchestrator(value, catalog_fetch=_all_live, **kwargs)

                    def fake_urlopen(_request, timeout):
                        raise ValueError("private synthetic error " + head + tail)

                    with (
                        patch.object(sc, "Orchestrator", side_effect=factory),
                        patch("urllib.request.urlopen", side_effect=fake_urlopen),
                    ):
                        result = sc.Sidecar(events.append).dispatch(
                            {
                                "id": command,
                                "cmd": command,
                                "args": args,
                            }
                        )
                    self.assertFalse(result["ok"])
                    self.assertNotIn(head, json.dumps(result) + json.dumps(events))
                    self.assertNotIn(tail, json.dumps(result) + json.dumps(events))
                    if kind == "unexpected":
                        self.assertTrue(
                            any(
                                event.get("key") == "log_ai_plan_error"
                                for event in events
                            )
                        )


if __name__ == "__main__":
    unittest.main()
