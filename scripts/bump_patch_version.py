#!/usr/bin/env python3
"""Bump every project version source and promote the Unreleased changelog."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


# OpenAI-Codex_format_architecture: locate values by their JSON object path.
def _json_object_fields(content: str, start: int) -> dict[str, tuple[int, int]]:
    decoder = json.JSONDecoder()

    def skip_whitespace(index: int) -> int:
        while index < len(content) and content[index] in " \t\r\n":
            index += 1
        return index

    index = skip_whitespace(start)
    if index >= len(content) or content[index] != "{":
        raise ValueError("Expected a JSON object")

    fields: dict[str, tuple[int, int]] = {}
    index = skip_whitespace(index + 1)
    while index < len(content) and content[index] != "}":
        key, index = decoder.raw_decode(content, index)
        if not isinstance(key, str) or key in fields:
            raise ValueError("Invalid or duplicate JSON object key")
        index = skip_whitespace(index)
        if index >= len(content) or content[index] != ":":
            raise ValueError("Expected a JSON object colon")
        value_start = skip_whitespace(index + 1)
        _, value_end = decoder.raw_decode(content, value_start)
        fields[key] = (value_start, value_end)
        index = skip_whitespace(value_end)
        if index < len(content) and content[index] == ",":
            index = skip_whitespace(index + 1)
        elif index >= len(content) or content[index] != "}":
            raise ValueError("Expected a JSON object separator")
    if index >= len(content):
        raise ValueError("Unterminated JSON object")
    return fields


def _replace_json_version(path: Path, old: str, new: str, *, lockfile: bool) -> str:
    content = path.read_bytes().decode("utf-8")
    data = json.loads(content)
    if not isinstance(data, dict) or data.get("version") != old:
        raise ValueError(f"{path.relative_to(ROOT)} root version is not {old}")

    root_fields = _json_object_fields(content, 0)
    locations = [root_fields["version"]]
    if lockfile:
        packages = data.get("packages")
        root_package = packages.get("") if isinstance(packages, dict) else None
        if not isinstance(root_package, dict) or root_package.get("version") != old:
            raise ValueError(f"{path.relative_to(ROOT)} root package version is not {old}")
        package_fields = _json_object_fields(content, root_fields["packages"][0])
        root_package_fields = _json_object_fields(content, package_fields[""][0])
        locations.append(root_package_fields["version"])

    updated = content
    for value_start, value_end in sorted(locations, reverse=True):
        updated = updated[:value_start] + json.dumps(new) + updated[value_end:]

    data["version"] = new
    if lockfile:
        data["packages"][""]["version"] = new
    if json.loads(updated) != data:
        raise ValueError(f"Unexpected JSON changes in {path.relative_to(ROOT)}")
    return updated

def _replace_once(path: Path, content: str, pattern: str, replacement: str) -> str:
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
    if count != 1:
        raise ValueError(f"Expected one version field in {path.relative_to(ROOT)}")
    return updated


def _promote_changelog(content: str, version: str, date: str, pr_number: int) -> str:
    lines = content.splitlines(keepends=True)
    unreleased_index = next(
        (i for i, line in enumerate(lines) if re.match(r"^### Unreleased\s*$", line)),
        None,
    )
    if unreleased_index is None:
        raise ValueError("CHANGELOG.md has no '### Unreleased' section")

    next_heading = next(
        (i for i in range(unreleased_index + 1, len(lines))
         if re.match(r"^### ", lines[i])),
        len(lines),
    )
    notes = "".join(lines[unreleased_index + 1:next_heading]).strip()
    if not notes:
        notes = (
            "#### Maintenance\n"
            f"- Automated patch release after merged pull request #{pr_number}."
        )

    release_block = f"\n### [{version}] — {date}\n\n{notes}\n\n"
    return "".join(lines[:unreleased_index + 1]) + release_block + "".join(lines[next_heading:])


def build_changes(pr_number: int, date: str) -> tuple[str, dict[str, str]]:
    package_path = ROOT / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    current = package.get("version", "")
    match = VERSION_RE.fullmatch(current)
    if not match:
        raise ValueError(f"Expected a stable semantic version in package.json, found {current!r}")

    major, minor, patch = map(int, match.groups())
    version = f"{major}.{minor}.{patch + 1}"
    tag = f"v{version}"
    changes: dict[str, str] = {}

    json_sources = {
        "package.json": False,
        "package-lock.json": True,
        "frontend/package.json": False,
        "frontend/package-lock.json": True,
        "src-tauri/tauri.conf.json": False,
    }
    for relative, lockfile in json_sources.items():
        path = ROOT / relative
        changes[relative] = _replace_json_version(path, current, version, lockfile=lockfile)

    cargo_toml = "src-tauri/Cargo.toml"
    changes[cargo_toml] = _replace_once(
        ROOT / cargo_toml,
        (ROOT / cargo_toml).read_text(encoding="utf-8"),
        r'^version\s*=\s*"' + re.escape(current) + r'"$',
        f'version = "{version}"',
    )

    cargo_lock = "src-tauri/Cargo.lock"
    changes[cargo_lock] = _replace_once(
        ROOT / cargo_lock,
        (ROOT / cargo_lock).read_text(encoding="utf-8"),
        r'(^name = "multimedia-downloader"\nversion = ")' + re.escape(current) + r'("$)',
        rf"\g<1>{version}\g<2>",
    )

    readme = "README.md"
    changes[readme] = _replace_once(
        ROOT / readme,
        (ROOT / readme).read_text(encoding="utf-8"),
        r'^(# Multimedia Downloader — V)' + re.escape(current) + r"$",
        rf"\g<1>{version}",
    )

    engine_version = "engine/__init__.py"
    changes[engine_version] = _replace_once(
        ROOT / engine_version,
        (ROOT / engine_version).read_text(encoding="utf-8"),
        r'^(__version__\s*=\s*")' + re.escape(current) + r'("$)',
        rf"\g<1>{version}\g<2>",
    )

    changelog = "CHANGELOG.md"
    changelog_content = (ROOT / changelog).read_text(encoding="utf-8")
    changes[changelog] = _promote_changelog(changelog_content, version, date, pr_number)
    return tag, changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr-number", type=int, required=True)
    parser.add_argument("--date", help="Release date in YYYY-MM-DD form; defaults to Hong Kong time")
    parser.add_argument("--dry-run", action="store_true", help="Validate and list changes without writing")
    args = parser.parse_args()

    date = args.date or datetime.now(ZoneInfo("Asia/Hong_Kong")).date().isoformat()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        parser.error("--date must use YYYY-MM-DD")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        parser.error("--date must be a valid calendar date")

    try:
        tag, changes = build_changes(args.pr_number, date)
        if not args.dry_run:
            for relative, content in changes.items():
                (ROOT / relative).write_text(content, encoding="utf-8", newline="\n")
        print(tag)
        if args.dry_run:
            print(f"Validated {len(changes)} file updates for PR #{args.pr_number}; no files changed.")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.exit(1, f"Version bump failed: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
