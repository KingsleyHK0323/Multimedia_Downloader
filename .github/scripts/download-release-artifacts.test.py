#!/usr/bin/env python3
"""OpenAI-Codex_format_architecture: test bounded artifact downloads without a network."""

import hashlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "release_download", Path(__file__).with_name("download-release-artifacts.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


class FakeProcess:
    def __init__(self, data=b"archive", status=0):
        self.stdout = io.BytesIO(data)
        self.status = status
        self.terminated = False

    def wait(self):
        return self.status

    def terminate(self):
        self.terminated = True


class ReleaseDownloadTests(unittest.TestCase):
    def test_stream_verifies_bytes_and_digest(self):
        target = io.BytesIO()
        self.assertEqual(
            module.copy_checked(io.BytesIO(b"data"), target, digest(b"data"), 100), 4
        )
        self.assertEqual(target.getvalue(), b"data")

    def test_stream_rejects_excess_missing_and_wrong_digest(self):
        for data, expected, limit in (
            (b"long", digest(b"long"), 3),
            (b"", digest(b""), 10),
            (b"data", digest(b"wrong"), 10),
        ):
            with self.subTest(data=data):
                with self.assertRaises(ValueError):
                    module.copy_checked(io.BytesIO(data), io.BytesIO(), expected, limit)

    def test_download_uses_only_validated_ids_and_exclusive_files(self):
        data = b"archive"
        selection = [
            {
                "platform": platform,
                "id": i + 1,
                "size": len(data),
                "digest": digest(data),
            }
            for i, platform in enumerate(module.PLATFORMS)
        ]
        with tempfile.TemporaryDirectory() as root:
            processes = [FakeProcess(data) for _ in range(3)]
            with patch.object(
                module.subprocess, "Popen", side_effect=processes
            ) as call:
                module.download("KingsleyHK0323/Multimedia_Downloader", selection, root)
            self.assertEqual(call.call_count, 3)
            self.assertEqual((Path(root) / "ubuntu-22.04.zip").read_bytes(), data)
            for args, _ in call.call_args_list:
                self.assertEqual(args[0][:2], ["gh", "api"])
                self.assertNotIn("--clobber", args[0])
            with self.assertRaises(FileExistsError):
                module.download("KingsleyHK0323/Multimedia_Downloader", selection, root)

    def test_rejects_invalid_metadata_before_executing_a_command(self):
        selection = [
            {"platform": platform, "id": i + 1, "size": 7, "digest": digest(b"archive")}
            for i, platform in enumerate(module.PLATFORMS)
        ]
        selection[0]["id"] = "1;command"
        with tempfile.TemporaryDirectory() as root, patch.object(
            module.subprocess, "Popen"
        ) as call:
            with self.assertRaisesRegex(ValueError, "metadata"):
                module.download("KingsleyHK0323/Multimedia_Downloader", selection, root)
            call.assert_not_called()

    def test_single_platform_recovery_downloads_only_its_selected_zip(self):
        data = b"archive"
        selection = [
            {
                "platform": "macos-15",
                "id": 22,
                "size": len(data),
                "digest": digest(data),
            }
        ]
        with tempfile.TemporaryDirectory() as root, patch.object(
            module.subprocess, "Popen", return_value=FakeProcess(data)
        ) as call:
            module.download("KingsleyHK0323/Multimedia_Downloader", selection, root)
            self.assertEqual(call.call_count, 1)
            self.assertEqual((Path(root) / "macos-15.zip").read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
