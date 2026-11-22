#!/usr/bin/env python3
"""OpenAI-Codex_format_architecture: download verified, size-bounded artifact ZIP data."""

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

PLATFORMS = ("ubuntu-22.04", "macos-15", "windows-latest")
MAX_ARCHIVE = 2_000_000_000
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


def copy_checked(source, target, expected_digest, limit):
    if (
        not DIGEST.fullmatch(expected_digest)
        or not isinstance(limit, int)
        or limit <= 0
    ):
        raise ValueError("Invalid artifact download constraints.")
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ValueError("Artifact download exceeded its size limit.")
        digest.update(chunk)
        target.write(chunk)
    if total == 0 or "sha256:" + digest.hexdigest() != expected_digest:
        raise ValueError("Downloaded artifact digest mismatch.")
    return total


def download(repo, selection, destination):
    if (
        not REPO.fullmatch(repo)
        or not isinstance(selection, list)
        or len(selection) not in (1, 3)
    ):
        raise ValueError("Invalid artifact download request.")
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("Safe no-follow file creation is unavailable.")
    output = Path(destination)
    if not output.is_dir() or output.is_symlink():
        raise ValueError("A pre-created safe download directory is required.")
    entries = {
        item.get("platform"): item for item in selection if isinstance(item, dict)
    }
    if len(entries) != len(selection) or not set(entries).issubset(PLATFORMS):
        raise ValueError("Invalid platform selection.")
    plans = []
    for platform in PLATFORMS:
        if platform not in entries:
            continue
        item = entries[platform]
        artifact_id, advertised, expected = (
            item.get("id"),
            item.get("size"),
            item.get("digest"),
        )
        if (
            type(artifact_id) is not int
            or artifact_id <= 0
            or type(advertised) is not int
            or advertised <= 0
            or not isinstance(expected, str)
            or not DIGEST.fullmatch(expected)
        ):
            raise ValueError("Invalid artifact metadata.")
        limit = min(MAX_ARCHIVE, max(advertised * 4, advertised + 1_048_576))
        plans.append((platform, artifact_id, expected, limit))
    if len({artifact_id for _, artifact_id, _, _ in plans}) != len(plans):
        raise ValueError("Duplicate artifact identifiers.")
    for platform, artifact_id, expected, limit in plans:
        path = output / (platform + ".zip")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        command = ["gh", "api", f"repos/{repo}/actions/artifacts/{artifact_id}/zip"]
        try:
            with os.fdopen(descriptor, "wb") as target:
                # The executable and endpoint are fixed; repository and artifact ID are validated above.
                process = subprocess.Popen(
                    command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
                )  # noqa: S603
                try:
                    copy_checked(process.stdout, target, expected, limit)
                except BaseException:
                    process.terminate()
                    process.wait()
                    raise
                if process.wait() != 0:
                    raise RuntimeError("GitHub artifact download failed.")
        except BaseException:
            raise


def main(argv):
    if len(argv) != 2:
        raise ValueError("Expected selection JSON and download directory.")
    with open(argv[0], encoding="utf-8") as handle:
        selection = json.load(handle)
    download(os.environ.get("GITHUB_REPOSITORY", ""), selection, argv[1])


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, RuntimeError) as error:
        print(
            "::error::Release artifact download failed: " + str(error), file=sys.stderr
        )
        raise SystemExit(1)
