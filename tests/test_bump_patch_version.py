"""Regression coverage for the release version bump's JSON field selection."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

import _path  # noqa: F401
from scripts import bump_patch_version


# OpenAI-Codex_format_architecture: preserve unrelated fields and JSON formatting.
class ReplaceJsonVersionTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "fixture.json"
        root_patch = mock.patch.object(bump_patch_version, "ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def replace(self, source: str, *, lockfile: bool) -> str:
        self.path.write_bytes(source.encode("utf-8"))
        result = bump_patch_version._replace_json_version(
            self.path, "4.3.22", "4.3.23", lockfile=lockfile
        )
        self.assertEqual(self.path.read_bytes(), source.encode("utf-8"))
        return result

    def test_lockfile_reordered_dependency_and_root_versions(self):
        source = (
            '{\n'
            '  "packages": {\n'
            '    "node_modules/a": {"version": "4.3.22"},\n'
            '    "": {"name": "app", "version": "4.3.22"}\n'
            '  },\n'
            '  "version": "4.3.22"\n'
            '}\n'
        )
        expected = (
            '{\n'
            '  "packages": {\n'
            '    "node_modules/a": {"version": "4.3.22"},\n'
            '    "": {"name": "app", "version": "4.3.23"}\n'
            '  },\n'
            '  "version": "4.3.23"\n'
            '}\n'
        )
        self.assertEqual(self.replace(source, lockfile=True), expected)

    def test_crlf_lockfile_preserves_all_other_bytes(self):
        source = (
            '{\r\n'
            '  "packages": {\r\n'
            '    "node_modules/a": {"version": "4.3.22"},\r\n'
            '    "": {"version": "4.3.22"}\r\n'
            '  },\r\n'
            '  "version": "4.3.22"\r\n'
            '}\r\n'
        )
        expected = (
            '{\r\n'
            '  "packages": {\r\n'
            '    "node_modules/a": {"version": "4.3.22"},\r\n'
            '    "": {"version": "4.3.23"}\r\n'
            '  },\r\n'
            '  "version": "4.3.23"\r\n'
            '}\r\n'
        )
        self.assertEqual(self.replace(source, lockfile=True), expected)

    def test_manifest_nested_version_before_root_stays_unchanged(self):
        source = (
            '{\n'
            '  "metadata": {"version": "4.3.22"},\n'
            '  "version" : "4.3.22"\n'
            '}\n'
        )
        expected = (
            '{\n'
            '  "metadata": {"version": "4.3.22"},\n'
            '  "version" : "4.3.23"\n'
            '}\n'
        )
        self.assertEqual(self.replace(source, lockfile=False), expected)

    def test_escaped_json_keys_and_values_keep_other_text(self):
        source = (
            '{\n'
            r'  "pack\u0061ges": {"": {"version": "4.3.\u0032\u0032"}, '
            r'"node_modules/a": {"version": "4.3.22"}},' '\n'
            '  "version": "4.3.22"\n'
            '}\n'
        )
        expected = (
            '{\n'
            r'  "pack\u0061ges": {"": {"version": "4.3.23"}, '
            r'"node_modules/a": {"version": "4.3.22"}},' '\n'
            '  "version": "4.3.23"\n'
            '}\n'
        )
        self.assertEqual(self.replace(source, lockfile=True), expected)

    def test_duplicate_keys_on_target_paths_fail_closed(self):
        cases = (
            '{"version": "4.3.22", "version": "4.3.22"}',
            r'{"version": "4.3.22", "vers\u0069on": "4.3.22"}',
            '{"version": "4.3.22", "packages": {"": {"version": "4.3.22"}, '
            '"": {"version": "4.3.22"}}}',
            '{"version": "4.3.22", "packages": {"": {"version": "4.3.22"}}, '
            '"packages": {"": {"version": "4.3.22"}}}',
            '{"version": "4.3.22", "packages": {"": '
            '{"version": "4.3.22", "version": "4.3.22"}}}',
        )
        for source in cases:
            with self.subTest(source=source):
                self.path.write_bytes(source.encode("utf-8"))
                with self.assertRaisesRegex(ValueError, "duplicate JSON object key"):
                    bump_patch_version._replace_json_version(
                        self.path, "4.3.22", "4.3.23", lockfile='"packages"' in source
                    )
                self.assertEqual(self.path.read_bytes(), source.encode("utf-8"))

    def test_mismatched_lockfile_root_package_version_fails(self):
        source = '{"version": "4.3.22", "packages": {"": {"version": "1.0.0"}}}'
        self.path.write_bytes(source.encode("utf-8"))
        with self.assertRaisesRegex(ValueError, "root package version"):
            bump_patch_version._replace_json_version(
                self.path, "4.3.22", "4.3.23", lockfile=True
            )
        self.assertEqual(self.path.read_bytes(), source.encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
