"""
Standalone web backend for the V4.0/V4.1 frontend.

The desktop app runs the same Svelte frontend inside a Tauri shell, where Rust
spawns ``engine_sidecar.py`` per operation over stdio. This module gives that
*identical* frontend a real HTTP/SSE backend so it works as a deployable web app
(``python web_app.py`` → http://127.0.0.1:5000), with real yt-dlp downloads and
ffmpeg conversions — replacing the browser-only ``MockApi`` fallback.

Design: it reuses the SAME ``Sidecar`` dispatch and event protocol as the stdio
sidecar (see ``engine_sidecar.py``). Only the transport changes:

    stdio newline-JSON   →   HTTP POST (commands) + SSE stream (events)

so ``engine/`` and ``ai/orchestrator.py`` are untouched. One process-wide
``Sidecar`` handles one operation at a time (single-user model, mirroring the
desktop's ``self._active`` and V3.0's ``web_app.py``); events fan out to every
connected browser via Server-Sent Events.

Deploy notes:
    python web_app.py  # localhost:5000
    # LAN / server: replace the example IP with the actual server address.
    HOST=0.0.0.0 PORT=8000 MMDL_TRUSTED_HOSTS=192.168.1.12 python web_app.py
For production behind gunicorn, use a streaming-friendly worker for the SSE
endpoint, e.g. ``gunicorn -k gthread -w 1 --threads 8 web_app:app`` (a single
worker keeps the one-op-at-a-time model and shared event bus intact).

This remains a single-user service without built-in authentication. Same-origin
checks reduce some browser-originated cross-site requests but are not user
authentication, protection from a malicious local process, or complete DNS
rebinding protection. Do not expose it to an untrusted network without a
trusted authentication proxy. By default only ``localhost``, ``127.0.0.1`` and
``[::1]`` are accepted as request hosts. ``MMDL_TRUSTED_HOSTS`` replaces this
default with a comma-separated list of exact hostnames or IP addresses; include
any local hosts that should remain usable. ``MMDL_TRUSTED_ORIGINS`` may list
additional exact browser origins for an explicitly trusted reverse proxy.
Forward the intended Host and scheme through the proxy or configure them
explicitly. These checks are not user authentication.

Files produced by downloads/conversions land under ``MMDL_DOWNLOADS`` (default
``./downloads``) — a server-side directory — and are retrievable at
``/files/<name>``. In the browser, leave the save-path field blank to use it.
"""

from __future__ import annotations

import ipaddress
import json
import os
import queue
import sys
import threading
from urllib.parse import urlsplit

from flask import Flask, Response, jsonify, request, send_from_directory, url_for

import i18n
from engine import (
    AUDIO_FORMATS,
    BROWSERS,
    HARDWARE_VIDEO_FORMATS,
    QUALITY_PRESETS,
    VIDEO_ENCODERS,
    VIDEO_FORMATS,
)
from engine_sidecar import Sidecar
from web_upload import UploadError, UploadStore

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST = os.path.join(HERE, "frontend", "dist")
DOWNLOADS_DIR = os.environ.get("MMDL_DOWNLOADS", os.path.join(HERE, "downloads"))

app = Flask(__name__, static_folder=None)


def _configured_trusted_hosts(value):
    """Use explicit configured hosts, or only loopback hosts by default."""
    hosts = [host.strip() for host in (value or "").split(",") if host.strip()]
    return hosts or ["localhost", "127.0.0.1", "[::1]"]


def _hostname(authority):
    """Normalize a single HTTP Host authority without trusting its port."""
    if (
        not isinstance(authority, str)
        or not authority
        or not authority.isascii()
        or authority.endswith(":")
    ):
        return None
    if any(ord(ch) <= 32 or ord(ch) == 127 or ch in "/\\?#@" for ch in authority):
        return None
    if authority.startswith("["):
        _, closing, suffix = authority.partition("]")
        if not closing or (
            suffix and (not suffix.startswith(":") or not suffix[1:].isdecimal())
        ):
            return None
    try:
        parsed = urlsplit("//" + authority)
        if parsed.username is not None or parsed.password is not None:
            return None
        if parsed.path or parsed.query or parsed.fragment or not parsed.hostname:
            return None
        _ = parsed.port  # Reject non-numeric and out-of-range ports.
        hostname = parsed.hostname
        if ":" in hostname:
            if not authority.startswith("["):
                return None
            return ipaddress.IPv6Address(hostname).compressed.lower()
        try:
            return str(ipaddress.IPv4Address(hostname))
        except ipaddress.AddressValueError:
            return hostname.encode("idna").decode("ascii").lower()
    except (ValueError, UnicodeError):
        return None


def _is_trusted_host(authority, trusted_hosts):
    """Match exact hostnames; this is not a caller authentication check."""
    name = _hostname(authority)
    if name is None or not isinstance(trusted_hosts, (list, tuple, set)):
        return False
    return any(name == _hostname(host) for host in trusted_hosts)


# OpenAI-Codex_web_ai: browser origin checks are defense in depth, not auth.
app.config["MMDL_TRUSTED_ORIGINS"] = {
    value.strip().rstrip("/")
    for value in os.environ.get("MMDL_TRUSTED_ORIGINS", "").split(",")
    if value.strip()
}
# Keep this separate from Flask's TRUSTED_HOSTS: exact IPv6 parsing is enforced
# below without depending on the installed Werkzeug version's matching rules.
app.config["MMDL_TRUSTED_HOSTS"] = _configured_trusted_hosts(
    os.environ.get("MMDL_TRUSTED_HOSTS")
)


@app.before_request
def _protect_browser_post():
    """Reject unexpected hosts, browser origins and non-JSON command bodies.

    Clients without an Origin header remain supported, so this is not an
    authentication boundary. Operation control requests require JSON bodies.
    """
    authority = request.environ.get("HTTP_HOST")
    if not authority:
        authority = request.environ.get("SERVER_NAME", "")
        if authority and ":" in authority and not authority.startswith("["):
            # WSGI SERVER_NAME may be an unbracketed IPv6 literal.
            try:
                authority = f"[{ipaddress.IPv6Address(authority).compressed}]"
            except ipaddress.AddressValueError:
                pass
    if not _is_trusted_host(authority, app.config["MMDL_TRUSTED_HOSTS"]):
        return jsonify({"error": "untrusted request host"}), 400
    if request.method != "POST" or not request.path.startswith("/api/"):
        return None
    origin = request.headers.get("Origin")
    allowed = {request.host_url.rstrip("/")} | set(
        app.config["MMDL_TRUSTED_ORIGINS"] or ()
    )
    if origin is not None and origin not in allowed:
        return jsonify({"error": "untrusted request origin"}), 403
    if not request.is_json:
        return jsonify({"error": "application/json is required"}), 415
    return None


# ── Event bus: fan events out to every connected SSE client ──────────────────
_subscribers: set[queue.Queue] = set()
_sub_lock = threading.Lock()


def _emit(obj: dict) -> None:
    with _sub_lock:
        subs = list(_subscribers)
    for q in subs:
        q.put(obj)


# One shared dispatcher — same command handlers as the stdio sidecar.
_sidecar = Sidecar(_emit)


def _dispatch(cmd: str, args: dict, *, operation_id=None, before_execute=None):
    """Run one command through the shared Sidecar and unwrap its response."""
    req = {"id": cmd, "cmd": cmd, "args": args}
    if operation_id is not None:
        req["operation_id"] = operation_id
    if before_execute is not None:
        req["before_execute"] = before_execute
    resp = _sidecar.dispatch(req)
    if resp.get("ok"):
        return jsonify(_add_output_links(cmd, resp.get("result")))
    code = resp.get("error_code")
    status = 409 if code in {"busy", "invalid_operation"} else 500
    error = {"error": resp.get("error", "error")}
    if code:
        error["error_code"] = code
    return jsonify(error), status


# ── Path confinement ─────────────────────────────────────────────────────────
# Every path in a request comes from the browser, and the engine will happily
# read and write wherever it is pointed. Unconfined, that lets any client of a
# LAN-exposed server write files anywhere this process can write, and pull any
# media file on the host back out through /files/. The README has always said
# to add your own auth before exposing this beyond localhost, but that was the
# only thing standing between a `HOST=0.0.0.0` deployment and the filesystem.
#
# So paths are confined to MMDL_DOWNLOADS by default. Set
# MMDL_ALLOW_ABSOLUTE_PATHS=1 to restore the old behaviour -- meaningful for a
# single-user localhost run where reaching the rest of the disk is the point,
# and no worse than the desktop app, which has the same reach by design.
ALLOW_ABSOLUTE_PATHS = os.environ.get(
    "MMDL_ALLOW_ABSOLUTE_PATHS", ""
).strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

# OpenAI-Codex_web_ai: the internal namespace remains guarded when uploads are disabled.
_upload_store = UploadStore(
    DOWNLOADS_DIR, FRONTEND_DIST, restricted_paths=not ALLOW_ABSOLUTE_PATHS
)


class UnsafePath(ValueError):
    """A request asked for a path outside the downloads directory."""


# OpenAI-Codex_web_ai: preserve trusted remote paths without probing them.
def _is_unc_or_device_path(path):
    if os.name != "nt" or not isinstance(path, str):
        return False
    separator = chr(92)
    normalized = path.replace("/", separator)
    if (
        normalized.startswith(separator * 2 + "?" + separator)
        and len(normalized) >= 7
        and normalized[4].isascii()
        and normalized[4].isalpha()
        and normalized[5:7] == ":" + separator
    ):
        return False
    return (
        normalized.startswith(separator * 2)
        or normalized.startswith(separator + "??" + separator)
        or normalized.lower().startswith(separator + "device" + separator)
    )


def _deny_named_remote_upload_path(path):
    parts = path.replace(chr(92), "/").split("/")
    if any(
        part.split(":", 1)[0].rstrip(" .").casefold() == ".mmdl-uploads-v1"
        for part in parts
    ):
        raise UploadError("unsafe_path")
    if any(part.rstrip(" .").casefold() == ".mmdl-uploads-v1" for part in parts):
        raise UploadError("unsafe_path")


# OpenAI-Codex_web_ai: check both lexical and resolved paths before any file operation.
def _guard_upload_path(path, *, write=False):
    if _is_unc_or_device_path(path):
        _deny_named_remote_upload_path(path)
        return
    try:
        lexical = os.path.abspath(path)
        if _is_unc_or_device_path(lexical):
            _deny_named_remote_upload_path(lexical)
            return
        # Delegate raw absolute paths before any new realpath or drive probe.
        if os.path.isabs(path):
            candidate = path
        else:
            drive, tail = os.path.splitdrive(path)
            candidate = (
                os.path.join(os.path.abspath(drive + "."), tail)
                if drive
                else os.path.join(os.getcwd(), path)
            )
            if not os.path.isabs(candidate):
                candidate = lexical
        _upload_store.authorize_path(candidate, write=write)
        return
        resolved = os.path.realpath(path)
        _upload_store.authorize_path(lexical, write=write)
        if os.path.normcase(lexical) != os.path.normcase(resolved):
            _upload_store.authorize_path(resolved, write=write)
    except UploadError:
        raise
    except Exception:
        raise UploadError("unavailable") from None


def _upload_client_path(path):
    if ALLOW_ABSOLUTE_PATHS:
        return path
    # Preserve the original path for the store's local/remote classification.
    return os.path.join(DOWNLOADS_DIR, path)
    if _is_unc_or_device_path(DOWNLOADS_DIR) or _is_unc_or_device_path(path):
        return os.path.join(DOWNLOADS_DIR, path)
    return os.path.join(os.path.realpath(DOWNLOADS_DIR), path)


def _confine(path: str) -> str:
    """
    Return ``path`` resolved inside DOWNLOADS_DIR, or raise :class:`UnsafePath`.

    Resolves existing symlinks on both sides before comparing. This check does
    not prevent another process from changing the filesystem after validation.
    """
    if not isinstance(path, str) or "\x00" in path:
        raise UnsafePath("invalid path")
    root = os.path.realpath(DOWNLOADS_DIR)
    _guard_upload_path(os.path.join(root, path))
    candidate = os.path.realpath(os.path.join(root, path))
    try:
        inside = os.path.commonpath(
            [os.path.normcase(root), os.path.normcase(candidate)]
        ) == os.path.normcase(root)
    except ValueError:
        inside = False
    if not inside:
        raise UnsafePath(
            f"path {path!r} is outside the server's downloads directory; "
            "set MMDL_ALLOW_ABSOLUTE_PATHS=1 to allow arbitrary paths"
        )
    return candidate


def _save_path(value) -> str:
    """Resolve a save/output dir: use the caller's if given, else the server
    downloads dir. Web clients can't browse the server's filesystem, so a blank
    field means 'put it in the server's downloads folder'."""
    if value is not None and (not isinstance(value, str) or "\x00" in value):
        raise UnsafePath("invalid save path")
    p = (value or "").strip()
    if not p:
        _guard_upload_path(DOWNLOADS_DIR, write=True)
        return DOWNLOADS_DIR
    _guard_upload_path(_upload_client_path(p), write=True)
    return p if ALLOW_ABSOLUTE_PATHS else _confine(p)


def _prepare_downloads_dir() -> None:
    """Create the root only after Sidecar accepts a non-cancelled operation."""
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)


def _operation_id(body) -> str:
    value = body.get("operation_id")
    if not isinstance(value, str) or not value.strip():
        raise UnsafePath("operation_id is required")
    return value


def _choice(value, allowed, field: str, default: str) -> str:
    """
    Validate a client-supplied value against the engine's own catalogue.

    Blank falls back to the default; anything else must be a known value. These
    fields look harmless, but `dst_fmt` is concatenated into the output path
    downstream, so an unchecked one is a path-traversal vector that never
    touches `_confine()`.
    """
    if value is not None and not isinstance(value, str):
        raise UnsafePath(f"invalid {field}")
    v = (value or "").strip()
    if not v:
        return default
    if v not in allowed:
        raise UnsafePath(f"unknown {field}: {v!r}")
    return v


def _video_encoder_choice(value, output_format=None) -> str:
    """Require an exact encoder enum; only an omitted field gets the default."""
    if not isinstance(value, str) or value not in VIDEO_ENCODERS:
        raise UnsafePath("invalid video encoder")
    if value != "software" and (
        not isinstance(output_format, str)
        or output_format.lower() not in HARDWARE_VIDEO_FORMATS
    ):
        raise UnsafePath("video encoder does not support this output format")
    return value


def _bitrate(value) -> str:
    if not isinstance(value, str):
        raise UnsafePath("invalid bitrate")
    value = value.strip()
    digits = value.lstrip("0") or "0"
    if (
        not value.isascii()
        or not value.isdecimal()
        or len(digits) > 4
        or not 1 <= int(digits) <= 9999
    ):
        raise UnsafePath("invalid bitrate")
    return str(int(digits))


def _cookie_file(value):
    if value is None:
        return None
    if not isinstance(value, str) or "\x00" in value:
        raise UnsafePath("invalid cookie file path")
    path = value
    if not path.strip():
        return None
    _guard_upload_path(_upload_client_path(path))
    return path if ALLOW_ABSOLUTE_PATHS else _confine(path)


def _policy(value, overwrite_confirmed=False) -> str:
    policy = _choice(
        value, {"rename", "skip", "overwrite"}, "conflict policy", "rename"
    )
    if policy == "overwrite" and overwrite_confirmed is not True:
        raise UnsafePath("overwrite requires explicit confirmation")
    return policy


def _confine_all(paths) -> list[str]:
    """Confine a list of client-supplied file paths (conversion inputs)."""
    if paths is None:
        return []
    if not isinstance(paths, list):
        raise UnsafePath("invalid file list")
    if any(not isinstance(p, str) or "\x00" in p for p in paths):
        raise UnsafePath("invalid file path")
    for path in paths:
        _guard_upload_path(_upload_client_path(path))
    return list(paths) if ALLOW_ABSOLUTE_PATHS else [_confine(p) for p in paths]


def _confine_tasks(tasks, overwrite_confirmed=False) -> list[dict]:
    """
    Confine the paths inside an AI-planned task list.

    ``/api/run_queue`` used to hand these straight to the engine. The plan is
    reviewed by the user before it runs (decision D4), but the user reviewing it
    is not necessarily the person who owns the server, so the same confinement
    applies here.
    """
    if tasks is not None and not isinstance(tasks, list):
        raise UnsafePath("invalid task list")
    out = []
    for t in tasks or []:
        if not isinstance(t, dict):
            raise UnsafePath("invalid task")
        t = dict(t)
        if t.get("kind") == "download":
            raw_options = t.get("options")
            if raw_options is not None and not isinstance(raw_options, dict):
                raise UnsafePath("invalid download options")
            opts = dict(raw_options or {})
            if "noplaylist" in opts and type(opts["noplaylist"]) is not bool:
                raise UnsafePath("noplaylist must be a boolean")
            opts["save_path"] = _save_path(opts.get("save_path"))
            if "cookie_file" in opts:
                opts["cookie_file"] = _cookie_file(opts["cookie_file"])
            if "bitrate" in opts:
                opts["bitrate"] = _bitrate(opts["bitrate"])
            for key, allowed, default in (
                ("mode", {"video", "audio"}, "video"),
                ("video_fmt", set(VIDEO_FORMATS), "mp4"),
                ("audio_fmt", set(AUDIO_FORMATS), "mp3"),
                ("quality", set(QUALITY_PRESETS), "best"),
                ("browser", set(BROWSERS), "none"),
            ):
                if key in opts:
                    opts[key] = _choice(opts[key], allowed, key, default)
            t["options"] = opts
        if t.get("kind") == "convert":
            for key in ("src_path", "dst_path"):
                if isinstance(t.get(key), str) and t.get(key):
                    _guard_upload_path(
                        _upload_client_path(t[key]), write=(key == "dst_path")
                    )
                if t.get(key) and not ALLOW_ABSOLUTE_PATHS:
                    t[key] = _confine(t[key])
                elif t.get(key) and (not isinstance(t[key], str) or "\x00" in t[key]):
                    raise UnsafePath("invalid file path")
            t["conflict_policy"] = _policy(
                t.get("conflict_policy"), overwrite_confirmed
            )
            # OpenAI-Codex_Fork_Source_Code: validate before any operation setup.
            destination_format = (
                os.path.splitext(t["dst_path"])[1].lstrip(".")
                if isinstance(t.get("dst_path"), str)
                else ""
            )
            t["video_encoder"] = _video_encoder_choice(
                t.get("video_encoder", "software"), destination_format
            )
        out.append(t)
    return out


# OpenAI-Codex_web_ai: preview validates paths without granting overwrite.
def _confine_preview_queue(tasks) -> list[dict]:
    if not isinstance(tasks, list):
        raise UnsafePath("preview tasks must be a list")
    out = []
    seen_ids = set()
    for task in tasks:
        if not isinstance(task, dict) or task.get("kind") != "convert":
            raise UnsafePath("preview accepts only conversion tasks")
        task_id = task.get("task_id")
        if not isinstance(task_id, str) or not task_id.strip() or task_id in seen_ids:
            raise UnsafePath("preview task IDs must be non-empty and unique")
        seen_ids.add(task_id)
        item = {
            "kind": "convert",
            "task_id": task_id,
            "conflict_policy": _choice(
                task.get("conflict_policy"),
                {"rename", "skip", "overwrite"},
                "conflict policy",
                "rename",
            ),
        }
        for field in ("src_path", "dst_path"):
            value = task.get(field)
            if not isinstance(value, str) or not value.strip() or "\x00" in value:
                raise UnsafePath("preview requires valid source and destination paths")
            item[field] = value if ALLOW_ABSOLUTE_PATHS else _confine(value)
            _guard_upload_path(_upload_client_path(value), write=(field == "dst_path"))
        out.append(item)
    return out


def _output_url(path):
    """Link only an existing output under the server's downloads directory."""
    if not isinstance(path, str) or not path:
        return None
    try:
        # Sidecar results are filesystem paths relative to the server process,
        # unlike browser-supplied paths, which are relative to DOWNLOADS_DIR.
        full_path = _confine(os.path.realpath(path))
    except (UnsafePath, OSError):
        return None
    if not os.path.isfile(full_path):
        return None
    relative = os.path.relpath(full_path, os.path.realpath(DOWNLOADS_DIR))
    return url_for("files", name=relative.replace(os.sep, "/"))


def _preview_display_path(path):
    """Avoid exposing an out-of-root symlink target in restricted mode."""
    unavailable = "[unavailable]"
    if not isinstance(path, str) or not path or "\x00" in path:
        return unavailable
    try:
        if ALLOW_ABSOLUTE_PATHS:
            absolute = os.path.realpath(path)
            if not os.path.isabs(absolute):
                return unavailable
            try:
                confined = _confine(absolute)
            except UnsafePath:
                return absolute
            return os.path.relpath(confined, os.path.realpath(DOWNLOADS_DIR)).replace(
                os.sep, "/"
            )

        # OpenAI-Codex_web_ai: compare lexical names without resolving the target.
        absolute = os.path.abspath(path)
        if not os.path.isabs(absolute):
            return unavailable
        roots = [os.path.abspath(DOWNLOADS_DIR)]
        try:
            roots.append(os.path.realpath(DOWNLOADS_DIR))
        except (OSError, ValueError):
            pass
        for root in roots:
            try:
                if not os.path.isabs(root):
                    continue
                if os.path.commonpath(
                    [os.path.normcase(root), os.path.normcase(absolute)]
                ) != os.path.normcase(root):
                    continue
                relative = os.path.relpath(absolute, root)
                if (
                    not os.path.isabs(relative)
                    and relative != os.pardir
                    and not relative.startswith(os.pardir + os.sep)
                ):
                    return relative.replace(os.sep, "/")
            except (OSError, ValueError):
                continue
    except (OSError, ValueError):
        pass
    return unavailable


def _add_output_links(cmd: str, result):
    if not isinstance(result, dict):
        return result
    if cmd in {"preview_convert", "preview_queue"}:
        jobs = result.get("jobs", [])
        if isinstance(jobs, list):
            for job in jobs:
                if isinstance(job, dict):
                    for key in ("src", "dst"):
                        if key in job:
                            job[key] = _preview_display_path(job[key])
        return result
    collection, field = (
        ("jobs", "dst")
        if cmd == "convert"
        else ("tasks", "dst_path") if cmd == "run_queue" else (None, None)
    )
    items = result.get(collection, []) if collection else []
    if not isinstance(items, list):
        return result
    for item in items:
        if isinstance(item, dict) and item.get("status") == "done":
            link = _output_url(item.get(field))
            if link:
                item["download_url"] = link
    return result


@app.errorhandler(UnsafePath)
def _handle_unsafe_path(e: UnsafePath):
    """A rejected path is the caller's mistake, not a server fault -- 400, and
    say what was wrong so a legitimate local user knows about the opt-out."""
    return jsonify({"error": str(e)}), 400


# ── Command endpoints (mirror the Rust IPC commands in src-tauri/main.rs) ─────
# OpenAI-Codex_web_ai: cap JSON bodies before reading; proxies need independent limits.
_UPLOAD_CONTROL_BODY_LIMIT = 16 * 1024
_UPLOAD_CHUNK_BODY_LIMIT = 4 * ((262144 + 2) // 3) + 8192


def _read_upload_json(limit):
    length_header = request.environ.get("CONTENT_LENGTH")
    if request.environ.get("HTTP_TRANSFER_ENCODING"):
        raise UploadError("invalid_request")
    if (
        not isinstance(length_header, str)
        or not length_header
        or not length_header.isascii()
        or not length_header.isdecimal()
    ):
        raise UploadError("invalid_request")
    if len(length_header) > 12:
        raise UploadError("too_large")
    length = int(length_header)
    if length <= 0:
        raise UploadError("invalid_request")
    if length > limit:
        raise UploadError("too_large")
    try:
        parts = []
        remaining = length
        while remaining:
            part = request.stream.read(min(65536, remaining))
            if not isinstance(part, bytes) or not part or len(part) > remaining:
                raise UploadError("invalid_request")
            parts.append(part)
            remaining -= len(part)
        body = json.loads(b"".join(parts).decode("utf-8"))
    except UploadError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise UploadError("invalid_request") from None
    except Exception:
        raise UploadError("unavailable") from None
    if not isinstance(body, dict):
        raise UploadError("invalid_request")
    return body


def _upload_json_call(method, *args):
    try:
        return jsonify(method(*args))
    except UploadError:
        raise
    except Exception:
        raise UploadError("unavailable") from None


@app.errorhandler(UploadError)
def _handle_upload_error(error):
    return jsonify({"error": str(error), "error_code": error.code}), error.http_status


@app.get("/api/uploads/config")
def api_upload_config():
    return _upload_json_call(_upload_store.capabilities)


@app.post("/api/uploads")
def api_upload_create():
    body = _read_upload_json(_UPLOAD_CONTROL_BODY_LIMIT)
    return _upload_json_call(_upload_store.create, body.get("name"), body.get("size"))


@app.post("/api/uploads/chunk")
def api_upload_chunk():
    body = _read_upload_json(_UPLOAD_CHUNK_BODY_LIMIT)
    return _upload_json_call(
        _upload_store.write_chunk,
        body.get("upload_id"),
        body.get("offset"),
        body.get("data_base64"),
    )


@app.post("/api/uploads/finish")
def api_upload_finish():
    body = _read_upload_json(_UPLOAD_CONTROL_BODY_LIMIT)
    try:
        result = _upload_store.finish(body.get("upload_id"))
        path = result.get("path") if isinstance(result, dict) else None
        if (
            not isinstance(path, str)
            or not path
            or "\x00" in path
            or os.path.isabs(path)
            or os.path.splitdrive(path)[0]
        ):
            raise UploadError("unavailable")
        _confine(path)
        return jsonify({"path": path})
    except UploadError:
        raise
    except Exception:
        raise UploadError("unavailable") from None


@app.get("/api/formats")
def api_formats():
    return _dispatch("formats", {})


@app.get("/api/locales")
def api_locales():
    # Frontend expects the {code: name} map directly (Rust unwraps .available).
    resp = _sidecar.dispatch({"id": "locales", "cmd": "locales", "args": {}})
    return jsonify(resp.get("result", {}).get("available", {}))


# OpenAI-Codex_web_ai: reserve and stop only the identified Web operation.
@app.post("/api/operations")
def api_prepare_operation():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    command = a.get("command")
    if not isinstance(command, str) or command not in {
        "download",
        "convert",
        "run_queue",
    }:
        raise UnsafePath("invalid operation command")
    return _dispatch("prepare", {"command": command})


@app.post("/api/operations/release")
def api_release_operation():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    return _dispatch("release", {"operation_id": _operation_id(a)})


# OpenAI-Codex_web_ai: status is lifecycle state, not a success result.
@app.post("/api/operations/status")
def api_operation_status():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    return _dispatch("status", {"operation_id": _operation_id(a)})


@app.post("/api/download")
def api_download():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    noplaylist = a.get("noplaylist", False)
    if type(noplaylist) is not bool:
        raise UnsafePath("noplaylist must be a boolean")
    operation_id = _operation_id(a)
    args = {
        "urls": a.get("urls", []),
        "options": {
            "save_path": _save_path(a.get("save_path")),
            "mode": _choice(a.get("mode"), {"video", "audio"}, "mode", "video"),
            # The engine rejects these too -- that is the check that actually
            # protects the CLI, TUI and desktop app. Repeating it here only
            # buys a 400 instead of a 500 for a malformed request.
            "video_fmt": _choice(
                a.get("video_fmt"), set(VIDEO_FORMATS), "video format", "mp4"
            ),
            "audio_fmt": _choice(
                a.get("audio_fmt"), set(AUDIO_FORMATS), "audio format", "mp3"
            ),
            "quality": _choice(
                a.get("quality"), set(QUALITY_PRESETS), "quality preset", "best"
            ),
            "browser": _choice(a.get("browser"), set(BROWSERS), "browser", "none"),
            "bitrate": _bitrate(a.get("bitrate", "192")),
            "cookie_file": _cookie_file(a.get("cookie_file")),
            "noplaylist": noplaylist,
        },
    }
    return _dispatch(
        "download",
        args,
        operation_id=operation_id,
        before_execute=_prepare_downloads_dir,
    )


# OpenAI-Codex_Fork_Source_Code: expose metadata-only playlist preview.
@app.post("/api/preview_playlist")
def api_preview_playlist():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    url = a.get("url")
    if (
        not isinstance(url, str)
        or not url.strip()
        or "\x00" in url
        or len(url) > 8192
        or any(ord(char) < 32 for char in url)
    ):
        raise UnsafePath("invalid playlist URL")
    options = {
        # Metadata preview never creates or writes to the downloads directory.
        "save_path": "",
        "mode": _choice(a.get("mode"), {"video", "audio"}, "mode", "video"),
        "video_fmt": _choice(
            a.get("video_fmt"), set(VIDEO_FORMATS), "video format", "mp4"
        ),
        "audio_fmt": _choice(
            a.get("audio_fmt"), set(AUDIO_FORMATS), "audio format", "mp3"
        ),
        "quality": _choice(
            a.get("quality"), set(QUALITY_PRESETS), "quality preset", "best"
        ),
        "browser": _choice(a.get("browser"), set(BROWSERS), "browser", "none"),
        "bitrate": _bitrate(a.get("bitrate", "192")),
        "cookie_file": _cookie_file(a.get("cookie_file")),
    }
    return _dispatch("preview_playlist", {"url": url.strip(), "options": options})


@app.post("/api/convert")
def api_convert():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    operation_id = _operation_id(a)
    dst_fmt = _choice(
        a.get("dst_fmt"),
        set(VIDEO_FORMATS) | set(AUDIO_FORMATS),
        "output format",
        "mp4",
    )
    video_encoder = _video_encoder_choice(a.get("video_encoder", "software"), dst_fmt)
    args = {
        "files": _confine_all(a.get("files")),
        "dst_fmt": dst_fmt,
        "save_path": _save_path(a.get("save_path")),
        "conflict_policy": _policy(
            a.get("conflict_policy"), a.get("overwrite_confirmed")
        ),
        # OpenAI-Codex_Fork_Source_Code: absent clients retain software default.
        "video_encoder": video_encoder,
        # OpenAI-Codex_app_ui: forward explicit boolean confirmation.
        **(
            {"overwrite_confirmed": True}
            if a.get("overwrite_confirmed") is True
            else {}
        ),
    }
    return _dispatch(
        "convert",
        args,
        operation_id=operation_id,
        before_execute=_prepare_downloads_dir,
    )


@app.post("/api/preview_convert")
def api_preview_convert():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    return _dispatch(
        "preview_convert",
        {
            "files": _confine_all(a.get("files")),
            "dst_fmt": _choice(
                a.get("dst_fmt"),
                set(VIDEO_FORMATS) | set(AUDIO_FORMATS),
                "output format",
                "mp4",
            ),
            "save_path": _save_path(a.get("save_path")),
        },
    )


@app.post("/api/preview_queue")
def api_preview_queue():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    return _dispatch("preview_queue", {"tasks": _confine_preview_queue(a.get("tasks"))})


@app.post("/api/run_queue")
def api_run_queue():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    operation_id = _operation_id(a)
    return _dispatch(
        "run_queue",
        {
            "tasks": _confine_tasks(a.get("tasks"), a.get("overwrite_confirmed")),
            # OpenAI-Codex_app_ui: forward explicit boolean confirmation.
            **(
                {"overwrite_confirmed": True}
                if a.get("overwrite_confirmed") is True
                else {}
            ),
        },
        operation_id=operation_id,
        before_execute=_prepare_downloads_dir,
    )


@app.post("/api/ai_plan")
def api_ai_plan():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    return _dispatch(
        "ai_plan",
        {
            "api_key": a.get("api_key", ""),
            "prompt": a.get("prompt", ""),
            "context": a.get("context"),
        },
    )


@app.post("/api/stop")
def api_stop():
    a = request.get_json() or {}
    if not isinstance(a, dict):
        raise UnsafePath("invalid request")
    return _dispatch("stop", {"operation_id": _operation_id(a)})


# ── SSE event stream ─────────────────────────────────────────────────────────
@app.get("/events")
def events():
    def stream():
        q: queue.Queue = queue.Queue()
        with _sub_lock:
            _subscribers.add(q)
        try:
            yield ": connected\n\n"  # open the stream immediately
            while True:
                try:
                    obj = q.get(timeout=15)
                except queue.Empty:
                    obj = {"type": "heartbeat"}
                yield f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"
        finally:
            with _sub_lock:
                _subscribers.discard(q)

    return Response(
        stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering (nginx)
            "Connection": "keep-alive",
        },
    )


# ── Produced-file retrieval ──────────────────────────────────────────────────
@app.get("/files/<path:name>")
def files(name):
    root = os.path.realpath(DOWNLOADS_DIR)
    full_path = _confine(name)
    relative = os.path.relpath(full_path, root).replace(os.sep, "/")
    return send_from_directory(root, relative, as_attachment=True)


# ── Static frontend (built Svelte app) ───────────────────────────────────────
@app.get("/")
def index():
    _guard_upload_path(os.path.join(FRONTEND_DIST, "index.html"), write=True)
    return send_from_directory(FRONTEND_DIST, "index.html")


@app.get("/<path:path>")
def static_proxy(path):
    full = os.path.join(FRONTEND_DIST, path)
    _guard_upload_path(full, write=True)
    if os.path.isfile(full):
        return send_from_directory(FRONTEND_DIST, path)
    _guard_upload_path(os.path.join(FRONTEND_DIST, "index.html"), write=True)
    return send_from_directory(FRONTEND_DIST, "index.html")  # SPA fallback


def _server_url(host: str, port: int) -> str:
    """Format an HTTP display URL, including brackets for IPv6 literals."""
    display_host = host
    if ":" in host and not (host.startswith("[") and host.endswith("]")):
        display_host = f"[{host}]"
    return f"http://{display_host}:{port}"


def main() -> None:
    if not os.path.isdir(FRONTEND_DIST):
        sys.stderr.write(
            f"[web_app] frontend not built at {FRONTEND_DIST}\n"
            "  build it first:  npm run build:frontend:web\n"
        )
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    lang_note = ", ".join(i18n.available().keys())
    sys.stderr.write(
        f"[web_app] serving on {_server_url(host, port)}  (langs: {lang_note})\n"
    )
    # threaded=True so the SSE stream and command requests run concurrently.
    app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
