# OpenAI-Codex: exercise the streaming FFmpeg process interface with synthetic output.
# OpenAI-Codex_engine_cli
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import _path  # noqa: F401
import engine.converter as converter_module
from engine import Converter, ConvertJob


class MakeJobTests(unittest.TestCase):
    def test_dst_path_uses_save_path_and_fmt(self):
        conv = Converter(save_path=os.path.join("out", "dir"), dst_fmt="mp4")
        job = conv.make_job(os.path.join("in", "clip.mkv"))
        self.assertEqual(job.src_path, os.path.join("in", "clip.mkv"))
        self.assertEqual(job.dst_path, os.path.join("out", "dir", "clip.mp4"))
        self.assertEqual(job.status, "pending")


class PreviewTests(unittest.TestCase):
    @staticmethod
    def _filesystem(lstat, stat, samefile, realpath=lambda path: path):
        paths = SimpleNamespace(basename=os.path.basename, splitext=os.path.splitext,
                                join=os.path.join, abspath=os.path.abspath,
                                normcase=os.path.normcase, realpath=realpath, samefile=samefile)

        def forbidden(*args, **kwargs):
            raise AssertionError("preview must not mutate files")

        return SimpleNamespace(path=paths, lstat=lstat, stat=stat,
                               link=forbidden, replace=forbidden, unlink=forbidden, close=forbidden)

    def test_preview_reports_exists_missing_unknown_and_dangling_link(self):
        def lstat(path):
            name = os.path.basename(path)
            if name == "b.mp4":
                raise FileNotFoundError(path)
            if name == "c.mp4":
                raise PermissionError(path)
            return object()

        def stat(path):
            if os.path.basename(path) == "broken.mp4":
                raise FileNotFoundError(path)
            return object()

        def samefile(src, dst):
            if os.path.basename(dst) == "broken.mp4":
                raise FileNotFoundError(dst)
            return os.path.basename(dst) == "a.mp4" and os.path.basename(src) == "a.mov"

        fs = self._filesystem(lstat, stat, samefile)
        sources = [os.path.join("one", "a.mkv"), os.path.join("two", "a.mov"),
                   "b.mkv", "c.mkv", "broken.mkv"]
        with patch.object(converter_module, "os", fs), \
                patch.object(converter_module.tempfile, "mkstemp") as temporary, \
                patch.object(converter_module.subprocess, "Popen") as ffmpeg:
            jobs = Converter(save_path="out", dst_fmt="mp4").preview_batch(sources)
        self.assertEqual([job["existing"] for job in jobs],
                         ["exists", "exists", "missing", "unknown", "exists"])
        self.assertEqual([job["source_matches"] for job in jobs],
                         ["yes", "yes", "no", "unknown", "unknown"])
        self.assertTrue(jobs[0]["batch_duplicate"])
        self.assertTrue(jobs[1]["batch_duplicate"])
        self.assertTrue(all(job["batch_duplicate"] for job in jobs))
        temporary.assert_not_called()
        ffmpeg.assert_not_called()

    def test_preview_detects_batch_collisions_and_conservative_identity_failure(self):
        sources = [os.path.join("one", "a.mkv"), os.path.join("two", "a.mov"), "b.mkv"]
        fs = self._filesystem(lambda path: object(), lambda path: object(), lambda a, b: False)
        with patch.object(converter_module, "os", fs):
            jobs = Converter(save_path="out", dst_fmt="mp4").preview_batch(sources)
        self.assertEqual([job["batch_duplicate"] for job in jobs], [True, True, False])

        def failed_identity(path):
            if os.path.basename(path) == "b.mp4":
                raise PermissionError(path)
            return path

        fs = self._filesystem(lambda path: object(), lambda path: object(),
                              lambda a, b: False, realpath=failed_identity)
        with patch.object(converter_module, "os", fs):
            jobs = Converter(save_path="out", dst_fmt="mp4").preview_batch(sources)
        self.assertTrue(all(job["batch_duplicate"] for job in jobs))

    def test_preview_compares_all_sources_and_does_not_turn_errors_into_no(self):
        sources = [os.path.join("other", "clip.mkv"), os.path.join("out", "clip.mp4")]
        fs = self._filesystem(lambda path: object(), lambda path: object(),
                              lambda a, b: (_ for _ in ()).throw(PermissionError()))
        with patch.object(converter_module, "os", fs):
            jobs = Converter(save_path="out", dst_fmt="mp4").preview_batch(sources)
        self.assertEqual([job["source_matches"] for job in jobs], ["yes", "yes"])

        fs = self._filesystem(lambda path: object(), lambda path: object(),
                              lambda a, b: (_ for _ in ()).throw(PermissionError()))
        with patch.object(converter_module, "os", fs):
            job = Converter(save_path="out", dst_fmt="mp4").preview_batch(["other.mkv"])[0]
        self.assertEqual(job["source_matches"], "unknown")

    def test_cli_preview_does_not_create_or_convert(self):
        import cli

        row = {"src": "a.mkv", "dst": "out/a.mp4", "existing": "unknown",
               "batch_duplicate": True, "source_matches": "unknown"}
        args = SimpleNamespace(output="out", format="mp4", ffmpeg="unused", lang="en",
                               conflict_policy="rename", files=["a.mkv"], preview=True)
        translator = SimpleNamespace(t=lambda key, **kwargs: key)
        output = StringIO()
        with patch.object(cli, "Converter") as converter, patch.object(cli.os, "makedirs") as mkdir, \
                patch.object(cli.i18n, "Translator", return_value=translator), redirect_stdout(output):
            converter.return_value.preview_batch.return_value = [row]
            result = cli.cmd_convert(args, lambda *a, **k: None)
        self.assertEqual(result, 0)
        self.assertIn("preview_snapshot_hint", output.getvalue())
        self.assertIn("preview_unknown", output.getvalue())
        self.assertIn("preview_batch_duplicate", output.getvalue())
        self.assertIn("a.mkv", output.getvalue())
        mkdir.assert_not_called()
        converter.return_value.preview_batch.assert_called_once_with(["a.mkv"])
        converter.return_value.convert_batch.assert_not_called()

    def test_cli_preview_flag_keeps_normal_conversion_path(self):
        import cli

        self.assertTrue(cli.build_parser().parse_args(["convert", "--preview", "a.mkv"]).preview)
        args = SimpleNamespace(output="out", format="mp4", ffmpeg="unused",
                               conflict_policy="rename", files=["a.mkv"], preview=False)
        with patch.object(cli, "Converter") as converter, patch.object(cli.os, "makedirs") as mkdir, \
                redirect_stdout(StringIO()):
            converter.return_value.last_summary = {"total": 1, "succeeded": 1, "failed": 0,
                                                   "skipped": 0, "cancelled": False}
            self.assertEqual(cli.cmd_convert(args, lambda *a, **k: None), 0)
        mkdir.assert_called_once_with("out", exist_ok=True)
        converter.return_value.convert_batch.assert_called_once_with(["a.mkv"])
        converter.return_value.preview_batch.assert_not_called()


class ConvertOneTests(unittest.TestCase):
    def test_missing_ffmpeg_sets_no_ffmpeg(self):
        logs = []
        with tempfile.TemporaryDirectory() as output:
            conv = Converter(
                save_path=output, dst_fmt="mp4",
                log_cb=lambda level, key, **fmt: logs.append((level, key)),
                ffmpeg_bin="___definitely_not_a_real_ffmpeg___",
            )
            job = ConvertJob(src_path="a.mkv", dst_path=os.path.join(output, "a.mp4"))
            conv.convert_one(job)
        self.assertEqual(job.status, "no_ffmpeg")
        self.assertIn(("err", "log_no_ffmpeg"), logs)

    def test_job_update_cb_fires(self):
        seen = []
        with tempfile.TemporaryDirectory() as output:
            conv = Converter(
                save_path=output, dst_fmt="mp4",
                job_update_cb=lambda j: seen.append(j.status),
                ffmpeg_bin="___definitely_not_a_real_ffmpeg___",
            )
            job = ConvertJob(src_path="a.mkv", dst_path=os.path.join(output, "a.mp4"))
            conv.convert_one(job)
        # first "converting", then final "no_ffmpeg"
        self.assertEqual(seen[0], "converting")
        self.assertEqual(seen[-1], "no_ffmpeg")


class ConvertBatchSummaryTests(unittest.TestCase):
    """Same fix as the download batch: the closing line must not claim success
    when every conversion failed."""

    def _batch_summary(self, n=3):
        logs = []
        conv = Converter(
            save_path="out", dst_fmt="mp4",
            log_cb=lambda level, key, **fmt: logs.append((level, key, fmt)),
            ffmpeg_bin="___definitely_not_a_real_ffmpeg___",
        )
        conv.convert_batch(["a%d.mkv" % i for i in range(n)])
        return [line for line in logs if line[1].startswith("log_all_")]

    def test_all_fail_logs_error_not_ok(self):
        summary = self._batch_summary()
        self.assertEqual(len(summary), 1)
        self.assertEqual(summary[0][0], "err")
        self.assertEqual(summary[0][1], "log_all_convert_failed")
        self.assertEqual(summary[0][2], {"t": 3})

    def test_stopped_batch_does_not_count_untouched_jobs_as_failures(self):
        logs = []
        conv = Converter(
            save_path="out", dst_fmt="mp4",
            log_cb=lambda level, key, **fmt: logs.append((level, key, fmt)),
            ffmpeg_bin="___definitely_not_a_real_ffmpeg___",
        )
        # Stop right after the first job runs; jobs 2 and 3 stay "pending".
        conv.job_update_cb = lambda j: conv.stop() if j.status != "converting" else None
        conv.convert_batch(["a.mkv", "b.mkv", "c.mkv"])
        summary = [line for line in logs if line[1].startswith("log_all_")]
        self.assertEqual(len(summary), 1)
        # Only the one job that ran is counted -- not all three.
        self.assertEqual(summary[0][2], {"t": 1})



class DstFormatValidationTests(unittest.TestCase):
    """
    make_job() validates dst_fmt because that is where the destination path is
    assembled. A caller that checks its inputs and then hands them to a
    function which composes a path from them has only moved the problem.
    Checking here covers every frontend at once.
    """

    def test_bare_extension_accepted(self):
        job = Converter(save_path="out", dst_fmt="mp4").make_job("a.mkv")
        self.assertTrue(job.dst_path.endswith("a.mp4"))

    def test_traversal_rejected(self):
        with self.assertRaises(ValueError):
            Converter(save_path="out", dst_fmt="../../evil.mp4").make_job("a.mkv")

    def test_separators_rejected(self):
        for bad in ("a/b", r"a\b"):
            with self.assertRaises(ValueError):
                Converter(save_path="out", dst_fmt=bad).make_job("a.mkv")

    def test_empty_rejected(self):
        with self.assertRaises(ValueError):
            Converter(save_path="out", dst_fmt="").make_job("a.mkv")

    def test_error_names_the_expected_shape(self):
        with self.assertRaises(ValueError) as ctx:
            Converter(save_path="out", dst_fmt="x/y").make_job("a.mkv")
        self.assertIn("bare extension", str(ctx.exception))


class ConflictSafetyTests(unittest.TestCase):
    @staticmethod
    def _success(args, **kwargs):
        Path(args[-1]).write_bytes(b"converted")
        return SimpleNamespace(returncode=0, stderr=(), wait=lambda: 0)

    def test_default_rename_preserves_existing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            destination.write_bytes(b"existing")
            converter = Converter(save_path=directory, dst_fmt="mp4")
            with patch("engine.converter.subprocess.Popen", side_effect=self._success):
                job = converter.convert_batch(["clip.mkv"])[0]
            self.assertEqual(destination.read_bytes(), b"existing")
            self.assertNotEqual(Path(job.dst_path), destination)
            self.assertEqual(Path(job.dst_path).read_bytes(), b"converted")
            self.assertEqual(job.status, "done")

    def test_rename_handles_destination_created_during_transcode(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"

            def race(args, **kwargs):
                Path(args[-1]).write_bytes(b"converted")
                destination.write_bytes(b"other writer")
                return SimpleNamespace(returncode=0, stderr=(), wait=lambda: 0)

            converter = Converter(save_path=directory, dst_fmt="mp4")
            with patch("engine.converter.subprocess.Popen", side_effect=race):
                job = converter.convert_batch(["clip.mkv"])[0]
            self.assertEqual(destination.read_bytes(), b"other writer")
            self.assertNotEqual(Path(job.dst_path), destination)
            self.assertEqual(Path(job.dst_path).read_bytes(), b"converted")

    def test_skip_preserves_existing_destination_without_transcoding(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            destination.write_bytes(b"existing")
            converter = Converter(save_path=directory, dst_fmt="mp4", conflict_policy="skip")
            with patch("engine.converter.subprocess.Popen") as ffmpeg:
                job = converter.convert_batch(["clip.mkv"])[0]
            ffmpeg.assert_not_called()
            self.assertEqual(destination.read_bytes(), b"existing")
            self.assertEqual(job.status, "skipped")
            self.assertEqual(converter.last_summary["skipped"], 1)
            self.assertFalse(converter.last_summary["cancelled"])

    def test_failed_overwrite_does_not_damage_existing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            destination.write_bytes(b"existing")

            def fail(args, **kwargs):
                Path(args[-1]).write_bytes(b"partial")
                return SimpleNamespace(returncode=1, stderr=["failure"], wait=lambda: 1)

            converter = Converter(save_path=directory, dst_fmt="mp4", conflict_policy="overwrite")
            with patch("engine.converter.subprocess.Popen", side_effect=fail):
                job = converter.convert_batch(["clip.mkv"])[0]
            self.assertEqual(job.status, "error")
            self.assertEqual(destination.read_bytes(), b"existing")

    def test_explicit_overwrite_publishes_only_completed_output(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            destination.write_bytes(b"existing")
            converter = Converter(save_path=directory, dst_fmt="mp4", conflict_policy="overwrite")
            with patch("engine.converter.subprocess.Popen", side_effect=self._success):
                job = converter.convert_batch(["clip.mkv"])[0]
            self.assertEqual(job.status, "done")
            self.assertEqual(destination.read_bytes(), b"converted")

    def test_overwrite_does_not_clobber_an_input_in_the_same_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "clip.mkv"
            second = Path(directory) / "clip.mp4"
            first.write_bytes(b"first input")
            second.write_bytes(b"second input")
            converter = Converter(save_path=directory, dst_fmt="mp4", conflict_policy="overwrite")
            with patch("engine.converter.subprocess.Popen", side_effect=self._success):
                with self.assertRaisesRegex(ValueError, "overwrite"):
                    converter.convert_batch([str(first), str(second)])
            self.assertEqual(first.read_bytes(), b"first input")
            self.assertEqual(second.read_bytes(), b"second input")

    def test_rename_does_not_create_a_protected_source_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            reserved_source = Path(directory) / "clip (1).mp4"
            destination.write_bytes(b"existing")
            converter = Converter(save_path=directory, dst_fmt="mp4",
                                  protected_paths=[str(reserved_source)])
            with patch("engine.converter.subprocess.Popen", side_effect=self._success):
                job = converter.convert_batch(["clip.mkv"])[0]
            self.assertEqual(Path(job.dst_path), Path(directory) / "clip (2).mp4")
            self.assertFalse(reserved_source.exists())
            self.assertEqual(destination.read_bytes(), b"existing")

    def test_overwrite_protected_destination_created_during_transcode_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"

            def race(args, **kwargs):
                Path(args[-1]).write_bytes(b"converted")
                destination.write_bytes(b"other writer")
                return SimpleNamespace(returncode=0, stderr=(), wait=lambda: 0)

            converter = Converter(save_path=directory, dst_fmt="mp4", conflict_policy="overwrite",
                                  protected_paths=[str(destination)])
            with patch("engine.converter.subprocess.Popen", side_effect=race):
                job = converter.convert_one(converter.make_job("clip.mkv"))
            self.assertEqual(job.status, "error")
            self.assertEqual(destination.read_bytes(), b"other writer")
            self.assertFalse(list(Path(directory).glob(".mmdl-*")))

    def test_overwrite_protection_survives_destination_identity_change(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            realpath = os.path.realpath

            def changed_realpath(path):
                absolute = os.path.normcase(os.path.abspath(path))
                if absolute == os.path.normcase(str(destination)) and destination.exists():
                    return str(Path(directory) / "other.mp4")
                return realpath(path)

            def race(args, **kwargs):
                Path(args[-1]).write_bytes(b"converted")
                destination.write_bytes(b"other writer")
                return SimpleNamespace(returncode=0, stderr=(), wait=lambda: 0)

            with patch("engine.converter.os.path.realpath", side_effect=changed_realpath):
                converter = Converter(save_path=directory, dst_fmt="mp4", conflict_policy="overwrite",
                                      protected_paths=[str(destination)])
                with patch("engine.converter.subprocess.Popen", side_effect=race):
                    job = converter.convert_one(converter.make_job("clip.mkv"))
            self.assertEqual(job.status, "error")
            self.assertEqual(destination.read_bytes(), b"other writer")
            self.assertFalse(list(Path(directory).glob(".mmdl-*")))

    def test_batch_duplicate_overwrite_destinations_are_rejected_before_transcode(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            destination.write_bytes(b"existing")
            sources = [str(Path(directory) / "one" / "clip.mkv"),
                       str(Path(directory) / "two" / "clip.mov")]
            converter = Converter(save_path=directory, dst_fmt="mp4", conflict_policy="overwrite")
            with patch("engine.converter.subprocess.Popen") as ffmpeg:
                with self.assertRaisesRegex(ValueError, "overwrite"):
                    converter.convert_batch(sources)
            ffmpeg.assert_not_called()
            self.assertEqual(destination.read_bytes(), b"existing")

    def test_previously_stopped_duplicate_overwrite_batch_reports_cancellation(self):
        converter = Converter(save_path=".", dst_fmt="mp4", conflict_policy="overwrite")
        converter.stop()
        with patch("engine.converter.subprocess.Popen") as ffmpeg:
            jobs = converter.convert_batch(["one/clip.mkv", "two/clip.mov"])
        ffmpeg.assert_not_called()
        self.assertEqual([job.status for job in jobs], ["skipped", "skipped"])
        self.assertTrue(converter.last_summary["cancelled"])

    def test_stop_before_start_marks_every_job_skipped(self):
        converter = Converter(save_path=".", dst_fmt="mp4")
        converter.stop()
        with patch("engine.converter.subprocess.Popen") as ffmpeg:
            jobs = converter.convert_batch(["a.mkv", "b.mkv"])
        ffmpeg.assert_not_called()
        self.assertEqual([job.status for job in jobs], ["skipped", "skipped"])
        self.assertEqual(converter.last_summary, {
            "total": 2, "succeeded": 0, "failed": 0, "skipped": 2, "cancelled": True,
        })

    def test_unknown_conflict_policy_is_rejected(self):
        with self.assertRaises(ValueError):
            Converter(save_path=".", dst_fmt="mp4", conflict_policy="unknown")

    def test_unsupported_safe_publication_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            destination.write_bytes(b"existing")
            converter = Converter(save_path=directory, dst_fmt="mp4")
            with patch("engine.converter.subprocess.Popen", side_effect=self._success):
                with patch("engine.converter.os.link", side_effect=OSError("unsupported")):
                    job = converter.convert_batch(["clip.mkv"])[0]
            self.assertEqual(job.status, "error")
            self.assertIn("hard links", job.error)
            self.assertEqual(destination.read_bytes(), b"existing")

    def test_cli_skip_is_not_reported_as_failure(self):
        from cli import cmd_convert

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "clip.mp4"
            destination.write_bytes(b"existing")
            args = SimpleNamespace(output=directory, format="mp4", ffmpeg="unused",
                                   conflict_policy="skip", files=["clip.mkv"])
            with patch("engine.converter.subprocess.Popen") as ffmpeg:
                result = cmd_convert(args, lambda *a, **k: None)
            ffmpeg.assert_not_called()
            self.assertEqual(result, 0)
            self.assertEqual(destination.read_bytes(), b"existing")

if __name__ == "__main__":
    unittest.main()
