#!/usr/bin/env python3
"""OpenAI-Codex_format_architecture: extract only expected release data safely."""

import hashlib
import json
import os
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
MAX_FILE = 700_000_000
MAX_TOTAL = 2_000_000_000
MAX_ENTRIES = 100


def expected_by_platform(tag, allow_reserved=False):
    if not isinstance(tag, str) or not TAG.fullmatch(tag) or len(tag) > 51:
        raise ValueError("Invalid release tag.")
    if tag == "v4.3.3" and not allow_reserved:
        raise ValueError("v4.3.3 requires separate release authorization.")
    version = tag[1:]
    return {
        "ubuntu-22.04": {
            f"Multimedia.Downloader-{version}-1.x86_64.rpm",
            f"Multimedia.Downloader_{version}_amd64.AppImage",
            f"Multimedia.Downloader_{version}_amd64.deb",
        },
        "macos-15": {f"Multimedia.Downloader_{version}_aarch64.dmg"},
        "windows-latest": {
            f"Multimedia.Downloader_{version}_x64-setup.exe",
            f"Multimedia.Downloader_{version}_x64_en-US.msi",
        },
    }


def _safe_name(info):
    raw = info.filename
    if getattr(info, "orig_filename", raw) != raw:
        raise ValueError("Unsafe original artifact path.")
    if not isinstance(raw, str) or not raw or "\\" in raw or "\0" in raw:
        raise ValueError("Unsafe artifact path.")
    path = PurePosixPath(raw)
    parts = raw.rstrip("/").split("/")
    if path.is_absolute() or any(
        part in ("", ".", "..") or ":" in part for part in parts
    ):
        raise ValueError("Unsafe artifact path.")
    if any(ord(char) < 32 or ord(char) == 127 for char in raw):
        raise ValueError("Unsafe artifact path.")
    mode = (info.external_attr >> 16) & 0xFFFF
    if stat.S_ISLNK(mode):
        raise ValueError("Artifact symlinks are forbidden.")
    if not info.is_dir() and stat.S_IFMT(mode) not in (0, stat.S_IFREG):
        raise ValueError("Artifact entry is not a regular file.")
    if info.flag_bits & 1 or info.compress_type not in (
        zipfile.ZIP_STORED,
        zipfile.ZIP_DEFLATED,
    ):
        raise ValueError("Unsupported artifact encoding.")
    return path.name


def stage(tag, archives, destination, allow_reserved=False):
    expected = expected_by_platform(tag, allow_reserved=allow_reserved)
    if len(archives) not in (1, 3) or not set(archives).issubset(expected):
        raise ValueError("Invalid platform artifact selection.")
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("Safe no-follow file creation is unavailable.")
    out = Path(destination)
    if not out.is_dir() or out.is_symlink():
        raise ValueError("A pre-created safe staging directory is required.")
    selected = []
    seen = set()
    total = 0
    for platform, wanted in expected.items():
        if platform not in archives:
            continue
        with zipfile.ZipFile(archives[platform]) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ENTRIES:
                raise ValueError("Artifact has too many entries.")
            found = set()
            for info in infos:
                name = _safe_name(info)
                if info.is_dir():
                    continue
                name = re.sub(
                    r"^Multimedia Downloader(?=[_-])", "Multimedia.Downloader", name
                )
                if name not in wanted or name in found or name in seen:
                    raise ValueError("Unexpected or duplicate platform installer.")
                if info.file_size <= 0 or info.file_size > MAX_FILE:
                    raise ValueError("Installer exceeds safe size limits.")
                total += info.file_size
                if total > MAX_TOTAL:
                    raise ValueError("Installer total exceeds safe size limits.")
                found.add(name)
                seen.add(name)
                selected.append((platform, info.filename, name, info.file_size))
            if found != wanted:
                raise ValueError("Platform installer set is incomplete.")
    manifest = []
    for platform, source_name, name, expected_size in selected:
        target = out / name
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        with zipfile.ZipFile(archives[platform]) as archive, archive.open(
            source_name, "r"
        ) as src:
            descriptor = os.open(target, flags, 0o600)
            digest = hashlib.sha256()
            size = 0
            with os.fdopen(descriptor, "wb") as dst:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > expected_size:
                        raise ValueError("Installer exceeds declared size.")
                    digest.update(chunk)
                    dst.write(chunk)
            if size != expected_size:
                raise ValueError("Installer does not match declared size.")
        manifest.append(
            {"name": name, "size": size, "digest": "sha256:" + digest.hexdigest()}
        )
    return sorted(manifest, key=lambda item: item["name"])


def verify_archives(selection, archives):
    if not isinstance(selection, list) or len(selection) not in (1, 3):
        raise ValueError("Invalid artifact selection.")
    entries = {
        item.get("platform"): item for item in selection if isinstance(item, dict)
    }
    if len(entries) != len(selection) or set(entries) != set(archives):
        raise ValueError("Invalid artifact selection.")
    for platform, path in archives.items():
        wanted = entries[platform].get("digest")
        if not isinstance(wanted, str) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", wanted
        ):
            raise ValueError("Invalid archive digest.")
        archive = Path(path)
        if not archive.is_file() or archive.is_symlink():
            raise ValueError("Invalid downloaded archive.")
        if archive.stat().st_size <= 0 or archive.stat().st_size > MAX_TOTAL:
            raise ValueError("Downloaded archive exceeds safe size limits.")
        digest = hashlib.sha256()
        with archive.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        if "sha256:" + digest.hexdigest() != wanted:
            raise ValueError("Downloaded archive digest mismatch.")


def main(argv):
    if len(argv) != 4:
        raise ValueError(
            "Expected tag, staging directory, selection and download directory."
        )
    tag, destination, selection_path, download_directory = argv
    with open(selection_path, encoding="utf-8") as handle:
        selection = json.load(handle)
    if not isinstance(selection, list) or len(selection) not in (1, 3):
        raise ValueError("Invalid artifact selection.")
    platforms = [item.get("platform") for item in selection if isinstance(item, dict)]
    allow_reserved = os.environ.get("VERIFY_ONLY") == "true"
    allowed = expected_by_platform(tag, allow_reserved=allow_reserved)
    if (
        any(not isinstance(platform, str) for platform in platforms)
        or len(set(platforms)) != len(selection)
        or not set(platforms).issubset(allowed)
    ):
        raise ValueError("Invalid platform selection.")
    archives = {
        platform: str(Path(download_directory) / (platform + ".zip"))
        for platform in platforms
    }
    verify_archives(selection, archives)
    result = stage(tag, archives, destination, allow_reserved=allow_reserved)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print(
            "::error::Release artifact validation failed: " + str(error),
            file=sys.stderr,
        )
        raise SystemExit(1)
