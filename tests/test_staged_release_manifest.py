# OpenAI-Codex_Fork_GitHub_REPO: synthetic checks for release staging and verification.
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / ".github" / "scripts" / "staged_release_manifest.py"
SPEC = importlib.util.spec_from_file_location("staged_release_manifest", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class StagedReleaseManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        self.staged = self.root / "staged"
        self.bundle.mkdir()
        self.identity = {
            "source_sha": "a" * 40,
            "version": "4.3.21",
            "run_id": "123",
            "attempt": "1",
        }

    def tearDown(self):
        self.temp.cleanup()

    def make_bundle(self, platform):
        folder = self.bundle / platform
        folder.mkdir()
        names = MODULE.expected_names(self.identity["version"], platform)
        for name in sorted(names):
            source_name = name.replace("Multimedia.Downloader", "Multimedia Downloader", 1)
            (folder / source_name).write_bytes(("bytes:" + name).encode("utf-8"))
        return folder

    def stage_all(self):
        self.staged.mkdir()
        for platform in MODULE.PLATFORMS:
            self.make_bundle(platform)
            MODULE.stage_artifacts(
                self.bundle / platform,
                self.staged / ("staged-123-1-" + platform),
                self.identity["source_sha"],
                self.identity["version"],
                self.identity["run_id"],
                self.identity["attempt"],
                platform,
            )

    def test_stages_and_verifies_exact_six_assets(self):
        self.stage_all()
        names = MODULE.verify_artifacts(
            self.staged,
            self.identity["source_sha"],
            self.identity["version"],
            self.identity["run_id"],
            self.identity["attempt"],
        )
        self.assertEqual(len(names), 6)
        for folder in self.staged.iterdir():
            manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
            for asset in manifest["assets"]:
                path = folder / asset["name"]
                self.assertEqual(asset["size"], path.stat().st_size)
                self.assertEqual(asset["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_rejects_corrupted_bytes_and_identity_mismatch(self):
        self.stage_all()
        first = next(self.staged.glob("staged-123-1-macos-15/*.dmg"))
        first.write_bytes(b"changed")
        with self.assertRaises(MODULE.ManifestError):
            MODULE.verify_artifacts(
                self.staged,
                self.identity["source_sha"],
                self.identity["version"],
                self.identity["run_id"],
                self.identity["attempt"],
            )
        with self.assertRaises(MODULE.ManifestError):
            MODULE.verify_artifacts(
                self.staged,
                "b" * 40,
                self.identity["version"],
                self.identity["run_id"],
                self.identity["attempt"],
            )

    def test_rejects_extra_files_and_symlinked_assets(self):
        self.stage_all()
        folder = self.staged / "staged-123-1-windows-latest"
        (folder / "unexpected.txt").write_text("extra", encoding="utf-8")
        with self.assertRaises(MODULE.ManifestError):
            MODULE.verify_artifacts(
                self.staged,
                self.identity["source_sha"],
                self.identity["version"],
                self.identity["run_id"],
                self.identity["attempt"],
            )


if __name__ == "__main__":
    unittest.main()
