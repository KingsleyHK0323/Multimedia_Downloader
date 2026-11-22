# OpenAI-Codex_format_architecture: compute and independently verify Black plans from immutable Git data.
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile


def calculate(requested_base, target_output):
    import ast
    import io
    import tokenize
    import hashlib
    import json
    import os
    import pathlib
    import subprocess
    import sys
    import tempfile

    # OpenAI-Codex_health_release_architecture: source blobs are data, never imported.
    anchor = os.environ["FORMAT_ANCHOR"]
    repo = os.environ["FORMAT_GIT_DIR"]
    out = pathlib.Path(target_output)
    out.mkdir(parents=True, exist_ok=False)
    payload = out / "blobs"
    payload.mkdir()
    env = os.environ.copy()
    env.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )

    def git(*args):
        # Git arguments are constructed from validated object IDs and fixed options.
        return subprocess.check_output(  # noqa: S603
            ["git", "-C", repo, "-c", "core.hooksPath=/dev/null", *args],  # noqa: S607
            env=env,
        )

    def decode(raw):
        return raw.decode("utf-8", "strict")

    def safe(path):
        parts = path.split("/")
        return (
            bool(path)
            and not path.startswith("/")
            and all(
                part not in ("", ".", "..", ".git")
                and "\\" not in part
                and all(ord(ch) >= 32 and ord(ch) != 127 for ch in part)
                for part in parts
            )
        )

    def sha1(data):
        # Git identifies repository blobs with SHA-1; this is not a security digest.
        return hashlib.sha1(
            b"blob " + str(len(data)).encode() + b"\0" + data, usedforsecurity=False
        ).hexdigest()

    base = decode(git("rev-parse", "--verify", requested_base + "^{commit}")).strip()
    if len(base) != 40 or any(ch not in "0123456789abcdef" for ch in base):
        raise SystemExit("Invalid Source_Code commit.")
    ancestry = decode(git("rev-list", "--first-parent", base)).splitlines()
    if anchor not in ancestry:
        raise SystemExit(
            "Formatter anchor is not on the Source_Code first-parent chain."
        )
    history = list(reversed(ancestry[: ancestry.index(anchor)]))
    changed = set()
    last_change = {}
    previous = anchor
    for commit in history:
        parents = decode(git("rev-list", "--parents", "-n", "1", commit)).split()
        if len(parents) < 2 or parents[0] != commit or parents[1] != previous:
            raise SystemExit("First-parent history is incomplete.")
        raw = git(
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            "--diff-filter=ACMRD",
            previous,
            commit,
            "--",
            "*.py",
        )
        for item in raw.split(b"\0"):
            if item:
                name = decode(item)
                changed.add(name)
                last_change[name] = commit
        previous = commit
    if previous != base:
        raise SystemExit("Formatter history does not reach its base.")
    entries = {}
    for row in git("ls-tree", "-rz", "--full-tree", base).split(b"\0"):
        if not row:
            continue
        metadata, name = row.split(b"\t", 1)
        mode, kind, oid = decode(metadata).split(" ")
        name = decode(name)
        if name in entries:
            raise SystemExit("Duplicate Git tree path.")
        entries[name] = (mode, kind, oid)
    warnings = []
    eligible = []
    max_source = 25 * 1024 * 1024
    for name in sorted(changed):
        if not name.endswith(".py"):
            continue
        if not safe(name) or name.startswith(".github/workflows/"):
            warnings.append({"path": name, "reason": "unsafe-path"})
            continue
        entry = entries.get(name)
        if entry is None:
            continue
        mode, kind, oid = entry
        if kind != "blob" or mode not in ("100644", "100755"):
            warnings.append({"path": name, "reason": "not-regular-file"})
            continue
        size = int(decode(git("cat-file", "-s", oid)).strip())
        if size > max_source:
            warnings.append({"path": name, "reason": "source-over-25MiB"})
            continue
        eligible.append((name, mode, oid, size))
    config_paths = set()
    for name, _, _, _ in eligible:
        parent = pathlib.PurePosixPath(name).parent
        for directory in (parent, *parent.parents):
            candidate = str(directory / "pyproject.toml")
            if candidate.startswith("./"):
                candidate = candidate[2:]
            if candidate in entries:
                config_paths.add(candidate)
    configs = []
    for name in sorted(config_paths):
        if not safe(name):
            raise SystemExit("Unsafe formatter configuration path.")
        mode, kind, oid = entries[name]
        if kind != "blob" or mode != "100644":
            raise SystemExit("Formatter configuration must be a regular file.")
        size = int(decode(git("cat-file", "-s", oid)).strip())
        if size > 2 * 1024 * 1024:
            raise SystemExit("Formatter configuration exceeds 2 MiB.")
        data = git("cat-file", "blob", oid)
        if len(data) != size or sha1(data) != oid:
            raise SystemExit("Formatter configuration blob mismatch.")
        configs.append((name, oid, data))
    files = []
    total_output = 0
    max_batch_bytes = 40 * 1024 * 1024
    limited = False
    with tempfile.TemporaryDirectory(prefix="format-plan-") as temp:
        root = pathlib.Path(temp)
        (root / ".git").mkdir()
        home = root / ".formatter-home"
        home.mkdir()
        for name, _, data in configs:
            target = root.joinpath(*name.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        clean = {
            "HOME": str(home),
            "PATH": os.environ["PATH"],
            "LC_ALL": "C.UTF-8",
            "PYTHONNOUSERSITE": "1",
            "BLACK_CACHE_DIR": str(home / "cache"),
        }
        for offset in range(0, len(eligible), 50):
            group = eligible[offset : offset + 50]
            originals = {}
            for name, mode, oid, size in group:
                data = git("cat-file", "blob", oid)
                if len(data) != size or sha1(data) != oid:
                    raise SystemExit("Formatter source blob mismatch.")
                target = root.joinpath(*name.split("/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                originals[name] = data

            def run_black(names):
                try:
                    # All file names follow -- and are passed as separate arguments.
                    return (
                        subprocess.run(  # noqa: S603
                            [
                                sys.executable,
                                "-I",
                                "-m",
                                "black",
                                "--quiet",
                                "--",
                                *names,
                            ],
                            cwd=root,
                            env=clean,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            timeout=240,
                            check=False,
                        ).returncode
                        == 0
                    )
                except subprocess.TimeoutExpired:
                    return False

            names = [item[0] for item in group]
            successful = set(names) if run_black(names) else set()
            if not successful:
                # Preserve the original 50-file group's Black root when retrying one file.
                try:
                    from black.files import find_project_root

                    previous_dir = os.getcwd()
                    os.chdir(root)
                    try:
                        project_root, _ = find_project_root(tuple(names))
                    finally:
                        os.chdir(previous_dir)
                    project_root.relative_to(root)
                    marker = project_root / (
                        ".format-context-"
                        + hashlib.sha256("\0".join(names).encode("utf-8")).hexdigest()
                        + ".py"
                    )
                    if marker.exists():
                        raise ValueError("Formatter context marker already exists.")
                    marker.write_text("pass\n", encoding="utf-8")
                    marker_name = marker.relative_to(root).as_posix()
                    for name, _, _, _ in group:
                        root.joinpath(*name.split("/")).write_bytes(originals[name])
                        if run_black([name, marker_name]):
                            successful.add(name)
                        else:
                            warnings.append(
                                {"path": name, "reason": "black-file-failed"}
                            )
                    marker.unlink()
                except (OSError, ValueError, RuntimeError):
                    warnings.extend(
                        {"path": name, "reason": "black-group-config-failed"}
                        for name, _, _, _ in group
                        if name not in successful
                    )
            for name, mode, oid, _ in group:
                if name not in successful:
                    continue
                original = originals[name]
                formatted = root.joinpath(*name.split("/")).read_bytes()
                if formatted == original:
                    continue
                try:
                    before_encoding, _ = tokenize.detect_encoding(
                        io.BytesIO(original).readline
                    )
                    after_encoding, _ = tokenize.detect_encoding(
                        io.BytesIO(formatted).readline
                    )
                    if before_encoding != after_encoding:
                        raise ValueError("Formatter changed the source encoding.")
                    before_ast = ast.dump(
                        ast.parse(
                            original.decode(before_encoding, "strict"),
                            type_comments=True,
                        )
                    )
                    after_ast = ast.dump(
                        ast.parse(
                            formatted.decode(after_encoding, "strict"),
                            type_comments=True,
                        )
                    )
                except (LookupError, UnicodeError, SyntaxError, ValueError):
                    warnings.append(
                        {"path": name, "reason": "invalid-python-or-encoding"}
                    )
                    continue
                if before_ast != after_ast:
                    warnings.append({"path": name, "reason": "changed-python-ast"})
                    continue
                if len(formatted) > max_source:
                    warnings.append({"path": name, "reason": "output-over-25MiB"})
                    continue
                if files and (
                    len(files) >= 50 or total_output + len(formatted) > max_batch_bytes
                ):
                    limited = True
                    break
                digest = hashlib.sha256(formatted).hexdigest()
                target = payload / digest
                if target.exists():
                    if target.read_bytes() != formatted:
                        raise SystemExit("Duplicate digest content mismatch.")
                else:
                    target.write_bytes(formatted)
                files.append(
                    {
                        "path": name,
                        "mode": mode,
                        "source": oid,
                        "last_change": last_change[name],
                        "output": sha1(formatted),
                        "sha256": digest,
                        "size": len(formatted),
                    }
                )
                total_output += len(formatted)
            if limited or len(files) >= 50:
                limited = True
                break
    warning_count = len(warnings)
    visible_warnings = [
        item for item in warnings if len(item["path"].encode("utf-8")) <= 4096
    ][:256]
    plan = {
        "anchor": anchor,
        "base": base,
        "black": "25.1.0",
        "configs": [{"path": name, "sha": oid} for name, oid, _ in configs],
        "files": files,
        "limited": limited,
        "warning_count": warning_count,
        "warnings": visible_warnings,
    }
    if warnings:
        print(
            "::warning::Formatter skipped "
            + str(warning_count)
            + " paths; see the plan warnings."
        )
    manifest = (json.dumps(plan, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )
    if len(manifest) > 4 * 1024 * 1024:
        raise SystemExit("Formatter manifest exceeds its safe limit.")
    (out / "manifest.json").write_bytes(manifest)
    return plan


repo = os.environ["FORMAT_GIT_DIR"]
output = pathlib.Path(os.environ["FORMAT_OUTPUT"])
service = os.environ.get("FORMAT_SERVICE_SHA", "")
git_env = os.environ.copy()
git_env.update(
    {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
    }
)


def git(*args):
    # Git arguments are constructed from validated object IDs and fixed options.
    return subprocess.check_output(  # noqa: S603
        ["git", "-C", repo, "-c", "core.hooksPath=/dev/null", *args],  # noqa: S607
        env=git_env,
    )


def is_ancestor(older, newer):
    # Both revisions are validated Git object IDs from repository metadata.
    result = subprocess.run(  # noqa: S603
        [  # noqa: S607
            "git",
            "-C",
            repo,
            "-c",
            "core.hooksPath=/dev/null",
            "merge-base",
            "--is-ancestor",
            older,
            newer,
        ],
        env=git_env,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode not in (0, 1):
        raise SystemExit("Cannot verify formatter ancestry.")
    return result.returncode == 0


def entries(commit):
    data = {}
    for row in git("ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not row:
            continue
        metadata, raw_name = row.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii", "strict").split(" ")
        name = raw_name.decode("utf-8", "strict")
        if name in data:
            raise SystemExit("Duplicate historical tree path.")
        data[name] = (mode, kind, oid)
    return data


def verify_old_tree(base, head, old_plan):
    before = entries(base)
    after = entries(head)
    if set(before) != set(after) or not old_plan["files"]:
        raise SystemExit(
            "Historical formatter changed the path inventory or has no output."
        )
    expected = {item["path"]: item for item in old_plan["files"]}
    if len(expected) != len(old_plan["files"]):
        raise SystemExit("Historical formatter plan has duplicate files.")
    for name, original in before.items():
        current = after[name]
        item = expected.get(name)
        if item:
            if original != (item["mode"], "blob", item["source"]) or current != (
                item["mode"],
                "blob",
                item["output"],
            ):
                raise SystemExit(
                    "Historical formatter output differs from independent recomputation."
                )
        elif original != current:
            raise SystemExit("Historical formatter contains an unrelated change.")


source = (
    git("rev-parse", "--verify", "refs/heads/source^{commit}")
    .decode("ascii", "strict")
    .strip()
)
if len(source) != 40 or any(ch not in "0123456789abcdef" for ch in source):
    raise SystemExit("Invalid current source SHA.")
if service and (
    len(service) != 40
    or any(ch not in "0123456789abcdef" for ch in service)
    or git("rev-parse", "--verify", "refs/heads/service^{commit}")
    .decode("ascii", "strict")
    .strip()
    != service
):
    raise SystemExit("Invalid service branch SHA.")
current = calculate(source, output)
prior = []
seen = set()
cache = {source: current}
cursor = service
with tempfile.TemporaryDirectory(prefix="formatter-history-") as scratch:
    while cursor and not is_ancestor(cursor, source):
        if len(prior) >= 32 or cursor in seen:
            raise SystemExit(
                "Formatter history is cyclic or exceeds 32 independently verified commits."
            )
        seen.add(cursor)
        values = (
            git("rev-list", "--parents", "-n", "1", cursor)
            .decode("ascii", "strict")
            .split()
        )
        if (
            len(values) not in (2, 3)
            or values[0] != cursor
            or not is_ancestor(values[1], source)
        ):
            raise SystemExit("Historical formatter parents are unsafe.")
        old_base = values[1]
        if old_base not in cache:
            old_output = pathlib.Path(scratch) / str(len(prior))
            cache[old_base] = calculate(old_base, old_output)
        verify_old_tree(old_base, cursor, cache[old_base])
        tree = (
            git("rev-parse", "--verify", cursor + "^{tree}")
            .decode("ascii", "strict")
            .strip()
        )
        digest_bytes = json.dumps(
            {"configs": cache[old_base]["configs"], "files": cache[old_base]["files"]},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        prior.append(
            {
                "base": old_base,
                "digest": hashlib.sha256(digest_bytes).hexdigest(),
                "head": cursor,
                "tree": tree,
            }
        )
        cursor = values[2] if len(values) == 3 else ""
current["service"] = service or None
current["prior"] = prior
manifest = (json.dumps(current, sort_keys=True, separators=(",", ":")) + "\n").encode(
    "utf-8"
)
if len(manifest) > 4 * 1024 * 1024:
    raise SystemExit("Formatter manifest exceeds its safe limit.")
(output / "manifest.json").write_bytes(manifest)
