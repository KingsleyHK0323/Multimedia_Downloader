"""Focused, in-memory checks for conversion result consistency.

OpenAI-Codex_engine_cli
"""
import ast
import os
import unittest
from pathlib import Path
from types import SimpleNamespace


class _MemoryConverter:
    jobs = []
    summary = {}

    def __init__(self, save_path, dst_fmt, conflict_policy, **_):
        self.save_path = save_path
        self.dst_fmt = dst_fmt
        self.conflict_policy = conflict_policy
        self.last_summary = self.summary

    def make_job(self, src):
        stem = os.path.splitext(os.path.basename(src))[0]
        return SimpleNamespace(dst_path=os.path.join(self.save_path, f"{stem}.{self.dst_fmt}"))

    def convert_batch(self, _files):
        return self.jobs


def _sidecar_type():
    source = (Path(__file__).resolve().parents[1] / "engine_sidecar.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Sidecar")
    method = next(node for node in original.body if isinstance(node, ast.FunctionDef) and node.name == "_cmd_convert")
    helpers = [node for node in tree.body if isinstance(node, ast.FunctionDef)
               and node.name == "_valid_conversion_results"]
    module = ast.Module(body=[
        ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
        *helpers,
        ast.ClassDef(name="ExtractedSidecar", bases=[], keywords=[], body=[method], decorator_list=[]),
    ], type_ignores=[])
    namespace = {"Converter": _MemoryConverter, "DEFAULT_FFMPEG": "ffmpeg", "os": os}
    exec(compile(ast.fix_missing_locations(module), "<memory sidecar>", "exec"), namespace)  # noqa: S102
    return namespace["ExtractedSidecar"]


def _job(src="a.mkv", *, status="done", error="", dst=None):
    return SimpleNamespace(src_path=src, dst_path=dst or os.path.join("out", "a.mp4"), status=status, error=error)


def _summary(total=1, succeeded=1, failed=0, skipped=0, cancelled=False):
    return dict(total=total, succeeded=succeeded, failed=failed, skipped=skipped, cancelled=cancelled)


class ConversionResultGuardTests(unittest.TestCase):
    def setUp(self):
        self.sidecar = _sidecar_type()()
        self.sidecar._callbacks = lambda _id: (lambda *_a, **_kw: None, None, None, None)
        self.sidecar._set_active = lambda _operation: None
        self.args = {"files": ["a.mkv"], "save_path": "out", "dst_fmt": "mp4"}
        _MemoryConverter.jobs = [_job()]
        _MemoryConverter.summary = _summary()

    def result(self):
        return self.sidecar._cmd_convert(self.args)

    def test_inconsistent_failed_row_is_not_reported_as_success(self):
        _MemoryConverter.jobs = [_job(status="error", error="failed")]
        with self.assertRaisesRegex(ValueError, "result is unknown"):
            self.result()

    def test_valid_result_is_preserved(self):
        result = self.result()
        self.assertEqual(result["jobs"][0]["src"], "a.mkv")
        self.assertEqual(result["summary"], _summary())

    def test_input_and_output_must_match_their_expected_order(self):
        self.args["files"] = ["a.mkv", "b.mkv"]
        _MemoryConverter.summary = _summary(total=2, succeeded=2)
        b = _job("b.mkv", dst=os.path.join("out", "b.mp4"))
        for jobs in ([b, _job()], [_job(dst=os.path.join("out", "b.mp4")), b]):
            with self.subTest(jobs=jobs):
                _MemoryConverter.jobs = jobs
                with self.assertRaisesRegex(ValueError, "result is unknown"):
                    self.result()

    def test_rename_allows_only_valid_numbered_destinations(self):
        _MemoryConverter.jobs = [_job(dst=os.path.join("out", "a (2).mp4"))]
        self.assertEqual(self.result()["jobs"][0]["status"], "done")
        for dst in (os.path.join("out", "a (01).mp4"), os.path.join("elsewhere", "a (2).mp4")):
            with self.subTest(dst=dst):
                _MemoryConverter.jobs = [_job(dst=dst)]
                with self.assertRaisesRegex(ValueError, "result is unknown"):
                    self.result()
        self.args["conflict_policy"] = "overwrite"
        # OpenAI-Codex_engine_cli: preserve the confirmed overwrite scenario.
        self.args["overwrite_confirmed"] = True
        _MemoryConverter.jobs = [_job(dst=os.path.join("out", "a (2).mp4"))]
        with self.assertRaisesRegex(ValueError, "result is unknown"):
            self.result()

    def test_invalid_rows_and_summaries_are_not_accepted(self):
        for job in (None, _job(status="pending"), _job(error="unexpected"), _job(error=42)):
            with self.subTest(job=job):
                _MemoryConverter.jobs = [job]
                with self.assertRaisesRegex(ValueError, "result is unknown"):
                    self.result()
        _MemoryConverter.jobs = [_job()]
        for summary in (_summary(total=True), _summary(cancelled=0), _summary(succeeded=0), {}):
            with self.subTest(summary=summary):
                _MemoryConverter.summary = summary
                with self.assertRaisesRegex(ValueError, "result is unknown"):
                    self.result()

    def test_valid_failure_cancellation_and_repeated_sources(self):
        self.args["files"] = ["a.mkv", "a.mkv"]
        _MemoryConverter.jobs = [_job(status="no_ffmpeg", error="not found"), _job(status="skipped")]
        _MemoryConverter.summary = _summary(total=2, succeeded=0, failed=1, skipped=1, cancelled=True)
        result = self.result()
        self.assertEqual([job["status"] for job in result["jobs"]], ["no_ffmpeg", "skipped"])
        self.assertTrue(result["summary"]["cancelled"])


if __name__ == "__main__":
    unittest.main()
