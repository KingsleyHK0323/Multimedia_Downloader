#!/usr/bin/env python3
"""OpenAI-Codex_Fork_GitHub_REPO: stage and verify six assets with hashes."""

import argparse
import hashlib
import json
import pathlib
import re
import shutil
import stat
import sys

PLATFORMS = {
    "ubuntu-22.04": [
        "Multimedia.Downloader-{version}-1.x86_64.rpm",
        "Multimedia.Downloader_{version}_amd64.AppImage",
        "Multimedia.Downloader_{version}_amd64.deb",
    ],
    "macos-15": [
        "Multimedia.Downloader_{version}_aarch64.dmg",
    ],
    "windows-latest": [
        "Multimedia.Downloader_{version}_x64-setup.exe",
        "Multimedia.Downloader_{version}_x64_en-US.msi",
    ],
}
SUFFIXES = (".rpm", ".AppImage", ".deb", ".dmg", ".msi", "-setup.exe")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
HEX256_RE = re.compile(r"^[0-9a-f]{64}$")


class ManifestError(ValueError):
    pass


def expected_names(version, platform):
    if platform not in PLATFORMS:
        raise ManifestError("Unsupported platform.")
    return {pattern.format(version=version) for pattern in PLATFORMS[platform]}


def _regular_file(path, root):
    try:
        mode = path.lstat().st_mode
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ManifestError("Artifact path is unavailable.") from exc
    if not stat.S_ISREG(mode) or not resolved.is_relative_to(root.resolve()):
        raise ManifestError("Artifact must be a regular file inside its expected directory.")
    return resolved


def _digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def stage_artifacts(bundle_root, output_dir, source_sha, version, run_id, attempt, platform):
    bundle_root = pathlib.Path(bundle_root)
    output_dir = pathlib.Path(output_dir)
    if not SHA_RE.fullmatch(source_sha):
        raise ManifestError("Invalid source SHA.")
    if not bundle_root.is_dir() or bundle_root.is_symlink():
        raise ManifestError("Bundle directory is unavailable.")
    names = expected_names(version, platform)
    source_names = {name: name.replace("Multimedia.Downloader", "Multimedia Downloader", 1) for name in names}
    candidates = [
        path for path in bundle_root.rglob("*")
        if path.name.endswith(SUFFIXES) and (path.is_file() or path.is_symlink())
    ]
    if len(candidates) != len(names) or {path.name for path in candidates} != set(source_names.values()):
        raise ManifestError("Unexpected installer inventory.")
    if output_dir.exists() or output_dir.is_symlink():
        raise ManifestError("Output directory already exists.")
    output_dir.mkdir(parents=True, exist_ok=False)

    assets = []
    for name in sorted(names):
        matches = list(bundle_root.rglob(source_names[name]))
        if len(matches) != 1:
            raise ManifestError("Expected exactly one installer file.")
        source = _regular_file(matches[0], bundle_root)
        if source.stat().st_size <= 0:
            raise ManifestError("Installer file is empty.")
        destination = output_dir / name
        shutil.copyfile(source, destination)
        assets.append({
            "name": name,
            "size": destination.stat().st_size,
            "sha256": _digest(destination),
        })

    manifest = {
        "sourceSha": source_sha,
        "version": version,
        "runId": str(run_id),
        "attempt": str(attempt),
        "platform": platform,
        "assets": assets,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return manifest


def _load_manifest(path):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
            raise ManifestError("Invalid manifest file.")
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ManifestError("Manifest cannot be parsed.") from exc


def verify_artifacts(root, source_sha, version, run_id, attempt, platforms=None):
    root = pathlib.Path(root)
    platforms = tuple(platforms or PLATFORMS.keys())
    if not SHA_RE.fullmatch(source_sha) or not root.is_dir() or root.is_symlink():
        raise ManifestError("Artifact root or source identity is invalid.")
    if len(platforms) != len(set(platforms)) or any(platform not in PLATFORMS for platform in platforms):
        raise ManifestError("Requested platform set is invalid.")
    expected_dirs = {
        "staged-" + str(run_id) + "-" + str(attempt) + "-" + platform
        for platform in platforms
    }
    entries = list(root.iterdir())
    if any(path.is_symlink() for path in entries) or {path.name for path in entries} != expected_dirs:
        raise ManifestError("Incomplete or unexpected artifact directories.")

    seen = set()
    for platform in platforms:
        folder = root / ("staged-" + str(run_id) + "-" + str(attempt) + "-" + platform)
        if folder.is_symlink() or not folder.is_dir():
            raise ManifestError("Platform artifact directory is invalid.")
        names = expected_names(version, platform)
        contents = list(folder.iterdir())
        if any(path.is_symlink() for path in contents) or {path.name for path in contents} != names | {"manifest.json"}:
            raise ManifestError("Unexpected platform artifact inventory.")

        manifest = _load_manifest(folder / "manifest.json")
        required_manifest_keys = {"sourceSha", "version", "runId", "attempt", "platform", "assets"}
        if not isinstance(manifest, dict) or set(manifest) != required_manifest_keys:
            raise ManifestError("Manifest schema mismatch.")
        identity = (manifest["sourceSha"], manifest["version"], manifest["runId"], manifest["attempt"], manifest["platform"])
        expected = (source_sha, version, str(run_id), str(attempt), platform)
        if identity != expected:
            raise ManifestError("Manifest identity mismatch.")

        assets = manifest["assets"]
        if not isinstance(assets, list) or len(assets) != len(names):
            raise ManifestError("Manifest asset inventory mismatch.")
        if any(not isinstance(asset, dict) or set(asset) != {"name", "size", "sha256"} for asset in assets):
            raise ManifestError("Manifest asset schema mismatch.")
        if any(not isinstance(asset["name"], str) for asset in assets) or {asset["name"] for asset in assets} != names:
            raise ManifestError("Manifest asset names mismatch.")

        for asset in assets:
            name = asset["name"]
            path = folder / name
            _regular_file(path, folder)
            size = path.stat().st_size
            if size <= 0 or isinstance(asset["size"], bool) or not isinstance(asset["size"], int):
                raise ManifestError("Artifact size is invalid.")
            if not isinstance(asset["sha256"], str) or not HEX256_RE.fullmatch(asset["sha256"]):
                raise ManifestError("Artifact digest is invalid.")
            if asset["size"] != size or asset["sha256"] != _digest(path) or name in seen:
                raise ManifestError("Artifact digest, size, or uniqueness mismatch.")
            seen.add(name)
    expected_total = sum(len(expected_names(version, platform)) for platform in platforms)
    if len(seen) != expected_total:
        raise ManifestError("The exact artifact set is incomplete.")
    return seen


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    stage = subparsers.add_parser("stage")
    stage.add_argument("--bundle-root", required=True)
    stage.add_argument("--output", required=True)
    stage.add_argument("--source-sha", required=True)
    stage.add_argument("--version", required=True)
    stage.add_argument("--run-id", required=True)
    stage.add_argument("--attempt", required=True)
    stage.add_argument("--platform", required=True, choices=PLATFORMS)
    verify = subparsers.add_parser("verify")
    verify.add_argument("--root", required=True)
    verify.add_argument("--source-sha", required=True)
    verify.add_argument("--version", required=True)
    verify.add_argument("--run-id", required=True)
    verify.add_argument("--attempt", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "stage":
            result = stage_artifacts(args.bundle_root, args.output, args.source_sha, args.version, args.run_id, args.attempt, args.platform)
            print("Staged " + str(len(result["assets"])) + " exact artifacts for " + args.platform + ".")
        else:
            result = verify_artifacts(args.root, args.source_sha, args.version, args.run_id, args.attempt)
            print("Verified exactly " + str(len(result)) + " artifacts.")
    except (ManifestError, OSError) as exc:
        print("::error::" + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
