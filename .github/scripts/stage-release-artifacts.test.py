#!/usr/bin/env python3
"""OpenAI-Codex_format_architecture: exercise untrusted ZIP extraction with fixtures."""

import importlib.util
import hashlib
import os
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "release_stage", Path(__file__).with_name("stage-release-artifacts.py")
)
stage_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage_module)

TAG = "v4.3.23"


def fixtures(root, extra=None):
    expected = stage_module.expected_by_platform(TAG)
    archives = {}
    for platform, names in expected.items():
        archive = Path(root) / (platform + ".zip")
        with zipfile.ZipFile(archive, "w") as out:
            for name in sorted(names):
                out.writestr("bundle/" + name.replace("Multimedia.Downloader", "Multimedia Downloader"), b"test data")
            if extra and platform == "ubuntu-22.04":
                info, payload = extra
                out.writestr(info, payload)
        archives[platform] = str(archive)
    return archives


class ReleaseStageTests(unittest.TestCase):
    def test_extracts_only_expected_installers_with_canonical_names(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "stage"
            target.mkdir()
            manifest = stage_module.stage(TAG, fixtures(root), target)
            expected = set().union(*stage_module.expected_by_platform(TAG).values())
            self.assertEqual({item["name"] for item in manifest}, expected)
            self.assertEqual({item.name for item in target.iterdir()}, expected)
            self.assertTrue(all((target / item["name"]).read_bytes() == b"test data" for item in manifest))

    def test_rejects_traversal_without_writing_files(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "stage"
            target.mkdir()
            for path in ("../evil", "/absolute/file", "bundle/../../evil", "bundle\\escape", "C:/file"):
                with self.subTest(path=path):
                    with self.assertRaisesRegex(ValueError, "Unsafe"):
                        stage_module.stage(TAG, fixtures(root, (path, b"evil")), target)
                    self.assertEqual(list(target.iterdir()), [])

    def test_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "stage"
            target.mkdir()
            info = zipfile.ZipInfo("bundle/link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            with self.assertRaisesRegex(ValueError, "symlinks"):
                stage_module.stage(TAG, fixtures(root, (info, b"target")), target)
            self.assertEqual(list(target.iterdir()), [])

    def test_rejects_duplicate_and_unexpected_files(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "stage"
            target.mkdir()
            duplicate = "bundle/Multimedia Downloader_4.3.23_amd64.deb"
            for path in (duplicate, "bundle/extra.sh"):
                with self.subTest(path=path):
                    with self.assertRaisesRegex(ValueError, "Unexpected or duplicate"):
                        stage_module.stage(TAG, fixtures(root, (path, b"duplicate")), target)
                    self.assertEqual(list(target.iterdir()), [])

    def test_never_overwrites_existing_paths(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "stage"
            target.mkdir()
            name = sorted(stage_module.expected_by_platform(TAG)["ubuntu-22.04"])[0]
            existing = target / name
            existing.write_bytes(b"original")
            with self.assertRaises(FileExistsError):
                stage_module.stage(TAG, fixtures(root), target)
            self.assertEqual(existing.read_bytes(), b"original")

    def test_v433_cannot_stage_for_publication(self):
        with self.assertRaisesRegex(ValueError, "separate release authorization"):
            stage_module.expected_by_platform("v4.3.3")
        self.assertTrue(stage_module.expected_by_platform("v4.3.3", allow_reserved=True))
        with self.assertRaisesRegex(ValueError, "Invalid release tag"):
            stage_module.expected_by_platform("v4.٣.٢٣")


    def test_downloaded_archive_digests_must_match_the_selected_artifacts(self):
        with tempfile.TemporaryDirectory() as root:
            archives = fixtures(root)
            selection = [
                {"platform": platform, "digest": "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()}
                for platform, path in archives.items()
            ]
            stage_module.verify_archives(selection, archives)
            selection[0]["digest"] = "sha256:" + "0" * 64
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                stage_module.verify_archives(selection, archives)



    def test_single_platform_recovery_stages_only_its_expected_files(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "stage"
            target.mkdir()
            all_archives = fixtures(root)
            manifest = stage_module.stage(TAG, {"macos-15": all_archives["macos-15"]}, target)
            self.assertEqual({item["name"] for item in manifest},
                             stage_module.expected_by_platform(TAG)["macos-15"])


if __name__ == "__main__":
    unittest.main()
