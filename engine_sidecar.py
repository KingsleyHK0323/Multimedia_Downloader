"""
Engine sidecar — the IPC boundary between the Tauri shell and the Python engine.

Protocol (newline-delimited JSON over stdio)
--------------------------------------------
The Tauri shell (Rust) spawns this process and speaks line-oriented JSON:

Requests  (shell -> sidecar), one JSON object per line::

    {"id": "<any>", "cmd": "<name>", "args": {...}}

Responses (sidecar -> shell), the terminal reply to a request::

    {"id": "<same id>", "ok": true,  "result": {...}}
    {"id": "<same id>", "ok": false, "error": "message"}

Events    (sidecar -> shell), streamed while a command runs (no id required)::

    {"type": "log",         "level": "info|ok|warn|err", "key": "<i18n key>", "fmt": {...}}
    {"type": "progress",    "pct": 42.0, "speed": "1.2MiB/s", "eta": "00:12"}
    {"type": "item_start",  "index": 1, "total": 3, "url": "..."}
    {"type": "task_update", "label": "...", "kind": "download|convert",
                            "status": "pending|running|done|error|skipped", "error": ""}

Commands
--------
ping                     -> {"pong": true}
formats                  -> {"video": [...], "audio": [...], "quality": [...], "browsers": [...]}
locales                  -> {"available": {code: name}}
strings   {lang}         -> {"lang": lang, "strings": {key: value}}
download  {urls, options}-> {"results": [[url, ok, error], ...]}     (streams log/progress/item_start)
preview_playlist {url, options}-> {"title", "entries", "total_entries", ...} (metadata only)
convert   {files, dst_fmt, save_path, ffmpeg_bin?}
                         -> {"jobs": [{src, dst, status, error}, ...]}  (streams log)
run_queue {tasks}        -> {"tasks": [{kind, label, status, error}, ...]} (streams log/task_update)
ai_plan   {api_key, prompt, context?}
                         -> {"summary": str, "tasks": [...], "warnings": [...]}  (streams log; NEVER
                            executes anything — the shell must call run_queue after user confirms, D4)
ai_summarize {api_key, results}
                         -> {"text": str}
stop                     -> {"stopping": true}   (cooperatively aborts the active op)

The engine emits i18n KEYS, not translated text; the frontend translates them.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import weakref
from typing import Callable, Optional
from uuid import uuid4

import i18n
from ai import Orchestrator, OrchestratorError
from engine import (
    AUDIO_FORMATS,
    BROWSERS,
    HARDWARE_VIDEO_FORMATS,
    QUALITY_PRESETS,
    VIDEO_ENCODERS,
    VIDEO_FORMATS,
    ConvertJob,
    Converter,
    Downloader,
    DownloadOptions,
    Task,
    TaskQueue,
)

Emit = Callable[[dict], None]
_LIVE_SIDECARS = weakref.WeakSet()


def _reset_sidecars_after_fork() -> None:
    for sidecar in list(_LIVE_SIDECARS):
        sidecar._after_fork()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_sidecars_after_fork)


class _BusyError(RuntimeError):
    pass


def resolve_ffmpeg() -> str:
    """
    Default ffmpeg binary to use.

    In a packaged (frozen) build, the Tauri bundle drops `ffmpeg.exe` next to
    this sidecar executable, so prefer that — the end user needn't have ffmpeg
    on PATH. In source runs, fall back to PATH `ffmpeg`. A caller can always
    override via the command's `ffmpeg_bin` arg.
    """
    if getattr(sys, "frozen", False):
        exe = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
        bundled = os.path.join(os.path.dirname(sys.executable), exe)
        if os.path.isfile(bundled):
            return bundled
    return "ffmpeg"


DEFAULT_FFMPEG = resolve_ffmpeg()


# OpenAI-Codex_engine_cli: reject contradictory terminal conversion results.
def _valid_conversion_results(files, jobs, summary, converter) -> bool:
    try:
        if not isinstance(files, (list, tuple)) or not isinstance(jobs, list):
            return False
        if len(files) != len(jobs) or not isinstance(summary, dict):
            return False
        counts = ("total", "succeeded", "failed", "skipped")
        if any(type(summary.get(key)) is not int or summary[key] < 0 for key in counts):
            return False
        if type(summary.get("cancelled")) is not bool or summary["total"] != len(files):
            return False
        seen = {"succeeded": 0, "failed": 0, "skipped": 0}
        for src, job in zip(files, jobs):
            if not isinstance(src, str) or getattr(job, "src_path", None) != src:
                return False
            dst = getattr(job, "dst_path", None)
            status = getattr(job, "status", None)
            error = getattr(job, "error", None)
            if not isinstance(dst, str) or not dst or not isinstance(error, str):
                return False
            if status == "done":
                if error:
                    return False
                seen["succeeded"] += 1
            elif status in ("error", "no_ffmpeg"):
                seen["failed"] += 1
            elif status == "skipped":
                seen["skipped"] += 1
            else:
                return False
            desired = converter.make_job(src).dst_path
            if dst != desired:
                if status != "done" or converter.conflict_policy != "rename":
                    return False
                stem, extension = os.path.splitext(desired)
                prefix, suffix = stem + " (", ")" + extension
                if not dst.startswith(prefix) or not dst.endswith(suffix):
                    return False
                number = dst[len(prefix) : -len(suffix)]
                if (
                    not number
                    or not number.isascii()
                    or not number.isdigit()
                    or number[0] == "0"
                ):
                    return False
        return all(summary[key] == count for key, count in seen.items())
    except Exception:
        return False


# OpenAI-Codex_engine_cli: freeze reviewed overwrite options before setup.
def _snapshot_overwrite_args(command, args):
    if not isinstance(args, dict):
        raise ValueError("operation arguments must be an object")
    snapshot = dict(args)
    if command == "convert":
        if isinstance(snapshot.get("files"), list):
            snapshot["files"] = list(snapshot["files"])
        overwrite_requested = snapshot.get("conflict_policy") == "overwrite"
    else:
        raw_tasks = snapshot.get("tasks")
        tasks = []
        if raw_tasks is not None:
            if isinstance(raw_tasks, (str, bytes, dict)):
                raise ValueError("queue tasks must be a sequence of objects")
            try:
                raw_tasks = list(raw_tasks)
            except TypeError:
                raise ValueError("queue tasks must be a sequence of objects") from None
            if any(not isinstance(task, dict) for task in raw_tasks):
                raise ValueError("queue tasks must be a sequence of objects")
            for task in raw_tasks:
                copied = dict(task)
                if isinstance(copied.get("options"), dict):
                    copied["options"] = dict(copied["options"])
                tasks.append(copied)
            snapshot["tasks"] = tasks
        overwrite_requested = any(
            task.get("kind") == "convert" and task.get("conflict_policy") == "overwrite"
            for task in tasks
        )
    if overwrite_requested and snapshot.get("overwrite_confirmed") is not True:
        raise ValueError("overwrite requires explicit confirmation")
    return snapshot


class Sidecar:
    """Dispatches IPC requests to the engine, streaming events via ``emit``."""

    def __init__(self, emit: Emit) -> None:
        self._emit = emit
        self._reset_process_state()
        _LIVE_SIDECARS.add(self)

    def _reset_process_state(self) -> None:
        # The currently running stoppable op (Downloader / Converter / TaskQueue).
        self._active: Optional[object] = None
        self._state_lock = threading.Lock()
        self._instance_id = str(uuid4())
        self._operation_sequence = 0
        self._current_command: Optional[str] = None
        self._current_operation_id: Optional[str] = None
        self._reservation: Optional[dict] = None
        self._completed: dict[str, float] = {}
        self._released: dict[str, float] = {}
        self._stop_requested = False

    def _after_fork(self) -> None:
        self._reset_process_state()

    _EXCLUSIVE_COMMANDS = {
        "download",
        "convert",
        "run_queue",
        "ai_plan",
        "ai_summarize",
    }
    _STOPPABLE_COMMANDS = {"download", "convert", "run_queue"}
    _RESERVATION_TTL = 120
    _COMPLETED_TTL = 300
    _COMPLETED_LIMIT = 128
    _RELEASED_TTL = 300
    _RELEASED_LIMIT = 128

    def _expire_reservation_locked(self) -> None:
        now = time.monotonic()
        if self._reservation and now >= self._reservation["expires_at"]:
            self._reservation = None
        for records, ttl in (
            (self._completed, self._COMPLETED_TTL),
            (self._released, self._RELEASED_TTL),
        ):
            for operation_id, recorded_at in list(records.items()):
                if now - recorded_at >= ttl:
                    del records[operation_id]

    # ── Dispatch ──────────────────────────────────────────────────────────────
    def dispatch(self, req: dict, _started: Optional[threading.Event] = None) -> dict:
        """Handle one request, return its terminal response dict."""
        rid = req.get("id")
        cmd = req.get("cmd")
        args = req.get("args") or {}
        if not isinstance(cmd, str):
            if _started is not None:
                _started.set()
            return {"id": rid, "ok": False, "error": "command must be a string"}
        exclusive = cmd in self._EXCLUSIVE_COMMANDS
        operation_id = req.get("operation_id") if "operation_id" in req else None
        cancelled_on_claim = False
        if exclusive:
            with self._state_lock:
                self._expire_reservation_locked()
                if "operation_id" in req:
                    reservation = self._reservation
                    if (
                        cmd not in self._STOPPABLE_COMMANDS
                        or not isinstance(operation_id, str)
                        or not operation_id
                        or reservation is None
                        or reservation["operation_id"] != operation_id
                        or reservation["command"] != cmd
                    ):
                        if _started is not None:
                            _started.set()
                        return {
                            "id": rid,
                            "ok": False,
                            "error_code": "invalid_operation",
                            "error": "operation reservation is invalid or expired",
                        }
                    cancelled_on_claim = reservation["cancelled"]
                elif self._reservation is not None:
                    if _started is not None:
                        _started.set()
                    return {
                        "id": rid,
                        "ok": False,
                        "error_code": "busy",
                        "error": "another operation is already running or reserved",
                    }
                else:
                    cancelled_on_claim = (
                        cmd in self._STOPPABLE_COMMANDS
                        and req.get("pre_cancelled") is True
                    )
                if self._current_command is not None:
                    if _started is not None:
                        _started.set()
                    return {
                        "id": rid,
                        "ok": False,
                        "error_code": "busy",
                        "error": "another operation is already running",
                    }
                if operation_id is not None:
                    self._reservation = None
                self._current_command = cmd
                self._current_operation_id = operation_id
                self._stop_requested = cancelled_on_claim
        if _started is not None:
            _started.set()
        try:
            handler = getattr(self, f"_cmd_{cmd}", None)
            if handler is None:
                return {"id": rid, "ok": False, "error": f"unknown cmd: {cmd!r}"}
            # OpenAI-Codex_engine_cli: reject unconfirmed overwrite before setup.
            if cmd in ("convert", "run_queue"):
                args = _snapshot_overwrite_args(cmd, args)
            hook = req.get("before_execute")
            if hook is not None:
                if not callable(hook):
                    raise ValueError("before_execute must be callable")
                if not cancelled_on_claim:
                    hook()
            result = (
                handler(args, operation_id)
                if cmd in self._STOPPABLE_COMMANDS
                else handler(args)
            )
            return {"id": rid, "ok": True, "result": result}
        except _BusyError as e:
            return {"id": rid, "ok": False, "error_code": "busy", "error": str(e)}
        except Exception as e:  # never let one bad request kill the loop
            return {"id": rid, "ok": False, "error": str(e)}
        finally:
            if exclusive:
                with self._state_lock:
                    if self._current_operation_id is not None:
                        self._expire_reservation_locked()
                        self._completed[self._current_operation_id] = time.monotonic()
                        while len(self._completed) > self._COMPLETED_LIMIT:
                            del self._completed[next(iter(self._completed))]
                    self._active = None
                    self._current_command = None
                    self._current_operation_id = None
                    self._stop_requested = False

    def _set_active(self, operation: object) -> None:
        """Attach a cancellable operation, preserving an earlier stop request."""
        with self._state_lock:
            self._active = operation
            if self._stop_requested and hasattr(operation, "stop"):
                operation.stop()

    def _callbacks(self, operation_id: Optional[str]):
        """Bind each event to the operation that created its callbacks."""

        def emit(event):
            if operation_id is not None:
                event["operation_id"] = operation_id
            self._emit(event)

        def log(level, key, **fmt):
            emit({"type": "log", "level": level, "key": key, "fmt": fmt})

        def progress(pct, speed, eta):
            emit({"type": "progress", "pct": pct, "speed": speed, "eta": eta})

        def item_start(index, total, url):
            emit({"type": "item_start", "index": index, "total": total, "url": url})

        def task_update(task):
            emit(
                {
                    "type": "task_update",
                    "task_id": task.task_id,
                    "label": task.label,
                    "kind": task.kind,
                    "status": task.status,
                    "error": task.error,
                }
            )

        return log, progress, item_start, task_update

    # ── Callback factories → JSON events ────────────────────────────────────────
    def _log_cb(self, level: str, key: str, **fmt) -> None:
        self._emit({"type": "log", "level": level, "key": key, "fmt": fmt})

    def _progress_cb(self, pct: float, speed: str, eta: str) -> None:
        self._emit({"type": "progress", "pct": pct, "speed": speed, "eta": eta})

    def _item_start_cb(self, index: int, total: int, url: str) -> None:
        self._emit({"type": "item_start", "index": index, "total": total, "url": url})

    def _task_update_cb(self, task: Task) -> None:
        self._emit(
            {
                "type": "task_update",
                "task_id": task.task_id,
                "label": task.label,
                "kind": task.kind,
                "status": task.status,
                "error": task.error,
            }
        )

    # ── Commands ────────────────────────────────────────────────────────────────
    def _cmd_ping(self, args: dict) -> dict:
        return {"pong": True}

    def _cmd_formats(self, args: dict) -> dict:
        return {
            "video": VIDEO_FORMATS,
            "audio": AUDIO_FORMATS,
            "quality": QUALITY_PRESETS,
            "browsers": BROWSERS,
            # OpenAI-Codex_Fork_Source_Code: these are choices, not GPU detection.
            "video_encoders": VIDEO_ENCODERS,
            "hardware_video_formats": HARDWARE_VIDEO_FORMATS,
        }

    def _cmd_locales(self, args: dict) -> dict:
        return {"available": i18n.available()}

    def _cmd_strings(self, args: dict) -> dict:
        lang = args.get("lang", i18n.DEFAULT_LANG)
        return {"lang": lang, "strings": i18n._load_all().get(lang, {})}

    def _cmd_download(self, args: dict, operation_id: Optional[str] = None) -> dict:
        raw_options = args.get("options")
        if not isinstance(raw_options, dict):
            raise ValueError("download options must be an object")
        if type(raw_options.get("noplaylist", False)) is not bool:
            raise ValueError("noplaylist must be a boolean")
        if args.get("require_absolute_paths"):
            self._require_native_absolute(raw_options.get("save_path"), "save path")
        # OpenAI-Codex: retain the legacy desktop cookie-only validation flag.
        if args.get("require_absolute_paths") or args.get(
            "require_absolute_cookie_path"
        ):
            cookie_file = raw_options.get("cookie_file")
            if cookie_file is not None and cookie_file != "":
                self._require_native_absolute(cookie_file, "cookie file")
        opts = DownloadOptions(**raw_options)
        log_cb, progress_cb, item_start_cb, _ = self._callbacks(operation_id)
        dl = Downloader(
            opts, log_cb=log_cb, progress_cb=progress_cb, item_start_cb=item_start_cb
        )
        self._set_active(dl)
        urls = list(args["urls"])
        results = dl.download_batch(urls)
        # Normalise (url, ok, err) tuples to JSON arrays for a stable contract.
        fallback = {
            "total": len(urls),
            "succeeded": sum(bool(r[1]) for r in results),
            "failed": sum(not r[1] for r in results),
            "skipped": len(urls) - len(results),
            "cancelled": False,
        }
        return {
            "results": [list(r) for r in results],
            "summary": getattr(dl, "last_summary", fallback),
        }

    def _cmd_preview_playlist(self, args: dict) -> dict:
        options = args.get("options")
        if not isinstance(options, dict):
            raise ValueError("playlist preview options must be an object")
        if args.get("require_absolute_paths"):
            cookie_file = options.get("cookie_file")
            if cookie_file is not None and cookie_file != "":
                self._require_native_absolute(cookie_file, "cookie file")
        clean_options = dict(options)
        clean_options.setdefault("save_path", "")
        downloader = Downloader(DownloadOptions(**clean_options))
        return downloader.preview_playlist(args.get("url"))

    def _cmd_preview_convert(self, args: dict) -> dict:
        if args.get("require_absolute_paths"):
            self._require_native_absolute(args.get("save_path"), "save path")
            for source in args.get("files", []):
                self._require_native_absolute(source, "conversion source")
        converter = Converter(save_path=args["save_path"], dst_fmt=args["dst_fmt"])
        return {"jobs": converter.preview_batch(args["files"])}

    # OpenAI-Codex_web_ai: preview reviewed queue pairs without starting work.
    def _cmd_preview_queue(self, args: dict) -> dict:
        tasks = args.get("tasks")
        if not isinstance(tasks, list):
            raise ValueError("preview tasks must be a list")
        ids = []
        seen_ids = set()
        jobs = []
        for task in tasks:
            if not isinstance(task, dict) or task.get("kind") != "convert":
                raise ValueError("preview accepts only conversion tasks")
            task_id = task.get("task_id")
            if (
                not isinstance(task_id, str)
                or not task_id.strip()
                or task_id in seen_ids
            ):
                raise ValueError("preview task IDs must be non-empty and unique")
            source, destination = task.get("src_path"), task.get("dst_path")
            if any(
                not isinstance(path, str) or not path.strip() or "\x00" in path
                for path in (source, destination)
            ):
                raise ValueError("preview requires valid source and destination paths")
            if (task.get("conflict_policy") or "rename") not in (
                "rename",
                "skip",
                "overwrite",
            ):
                raise ValueError("invalid conflict policy")
            if args.get("require_absolute_paths"):
                self._require_native_absolute(source, "conversion source")
                self._require_native_absolute(destination, "conversion destination")
            ids.append(task_id)
            seen_ids.add(task_id)
            jobs.append(ConvertJob(src_path=source, dst_path=destination))
        previews = Converter.preview_jobs(jobs)
        if len(previews) != len(ids) or any(
            not isinstance(row, dict) for row in previews
        ):
            raise ValueError("invalid queue preview result")
        return {
            "jobs": [{"task_id": task_id, **row} for task_id, row in zip(ids, previews)]
        }

    def _cmd_convert(self, args: dict, operation_id: Optional[str] = None) -> dict:
        # OpenAI-Codex_engine_cli: protect direct handler calls as well.
        args = dict(args)
        if isinstance(args.get("files"), list):
            args["files"] = list(args["files"])
        if (
            args.get("conflict_policy") == "overwrite"
            and args.get("overwrite_confirmed") is not True
        ):
            raise ValueError("overwrite requires explicit confirmation")
        if args.get("require_absolute_paths"):
            self._require_native_absolute(args.get("save_path"), "save path")
            for source in args.get("files", []):
                self._require_native_absolute(source, "conversion source")
        log_cb, _, _, _ = self._callbacks(operation_id)
        conv = Converter(
            save_path=args["save_path"],
            dst_fmt=args["dst_fmt"],
            log_cb=log_cb,
            ffmpeg_bin=args.get("ffmpeg_bin") or DEFAULT_FFMPEG,
            conflict_policy=args.get("conflict_policy") or "rename",
            video_encoder=args.get("video_encoder", "software"),
        )
        self._set_active(conv)
        jobs = conv.convert_batch(args["files"])
        if not _valid_conversion_results(
            args["files"], jobs, getattr(conv, "last_summary", None), conv
        ):
            raise ValueError(
                "Conversion result is unknown; check existing output files before trying again."
            )
        return {
            "jobs": [
                {
                    "src": j.src_path,
                    "dst": j.dst_path,
                    "status": j.status,
                    "error": j.error,
                }
                for j in jobs
            ],
            "summary": conv.last_summary,
        }

    def _cmd_run_queue(self, args: dict, operation_id: Optional[str] = None) -> dict:
        # OpenAI-Codex_engine_cli: protect direct handler calls as well.
        args = _snapshot_overwrite_args("run_queue", args)
        if args.get("require_absolute_paths"):
            for task in args.get("tasks", []):
                if task.get("kind") == "download":
                    options = task.get("options") or {}
                    self._require_native_absolute(options.get("save_path"), "save path")
                    cookie_file = options.get("cookie_file")
                    if cookie_file is not None and cookie_file != "":
                        self._require_native_absolute(cookie_file, "cookie file")
                elif task.get("kind") == "convert":
                    self._require_native_absolute(
                        task.get("src_path"), "conversion source"
                    )
                    self._require_native_absolute(
                        task.get("dst_path"), "conversion destination"
                    )
        tasks = [self._task_from_dict(t) for t in args["tasks"]]
        task_ids = [task.task_id for task in tasks]
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("task IDs must be unique")
        log_cb, _, _, task_update_cb = self._callbacks(operation_id)
        tq = TaskQueue(
            log_cb=log_cb,
            task_update_cb=task_update_cb,
            ffmpeg_bin=args.get("ffmpeg_bin") or DEFAULT_FFMPEG,
        )
        self._set_active(tq)
        tq.run(tasks)
        return {
            "tasks": [
                {
                    "task_id": t.task_id,
                    "kind": t.kind,
                    "label": t.label,
                    "status": t.status,
                    "error": t.error,
                    "dst_path": t.dst_path,
                }
                for t in tasks
            ],
            "summary": tq.last_summary,
        }

    def _cmd_ai_plan(self, args: dict) -> dict:
        orch = Orchestrator(args["api_key"], log_cb=self._log_cb)
        try:
            return orch.plan(args["prompt"], context=args.get("context"))
        except OrchestratorError as e:
            self._log_cb("err", "log_ai_plan_error", err=str(e))
            raise

    def _cmd_ai_summarize(self, args: dict) -> dict:
        orch = Orchestrator(args["api_key"])
        try:
            return {"text": orch.summarize(args["results"])}
        except OrchestratorError as e:
            self._log_cb("err", "log_ai_plan_error", err=str(e))
            raise

    def _cmd_prepare(self, args: dict) -> dict:
        command = args.get("command")
        if command not in self._STOPPABLE_COMMANDS:
            raise ValueError("command cannot be reserved")
        with self._state_lock:
            self._expire_reservation_locked()
            if self._current_command is not None or self._reservation is not None:
                raise _BusyError("another operation is already running or reserved")
            for _ in range(8):
                self._operation_sequence += 1
                operation_id = (
                    f"{self._instance_id}:{self._operation_sequence}:{uuid4()}"
                )
                if (
                    operation_id not in self._completed
                    and operation_id not in self._released
                ):
                    break
            else:
                raise RuntimeError("could not allocate a unique operation ID")
            self._reservation = {
                "operation_id": operation_id,
                "command": command,
                "expires_at": time.monotonic() + self._RESERVATION_TTL,
                "cancelled": False,
            }
        return {
            "operation_id": operation_id,
            "instance_id": self._instance_id,
            "command": command,
            "expires_in": self._RESERVATION_TTL,
        }

    def _cmd_release(self, args: dict) -> dict:
        operation_id = args.get("operation_id")
        with self._state_lock:
            self._expire_reservation_locked()
            if self._reservation and self._reservation["operation_id"] == operation_id:
                self._released[operation_id] = time.monotonic()
                while len(self._released) > self._RELEASED_LIMIT:
                    del self._released[next(iter(self._released))]
                self._reservation = None
                return {"released": True}
        return {"released": False}

    def _cmd_status(self, args: dict) -> dict:
        operation_id = args.get("operation_id")
        with self._state_lock:
            self._expire_reservation_locked()

            def snapshot(state):
                return {
                    "state": state,
                    "instance_id": self._instance_id,
                    "idle": self._current_command is None and self._reservation is None,
                }

            if not isinstance(operation_id, str) or not operation_id:
                return snapshot("unknown")
            if self._reservation and self._reservation["operation_id"] == operation_id:
                return snapshot("reserved")
            if (
                self._current_operation_id == operation_id
                and self._current_command is not None
            ):
                return snapshot("running")
            if operation_id in self._completed:
                return snapshot("completed")
            if operation_id in self._released:
                return snapshot("released")
            return snapshot("unknown")

    def _cmd_stop(self, args: dict) -> dict:
        with self._state_lock:
            self._expire_reservation_locked()
            if "operation_id" in args:
                operation_id = args.get("operation_id")
                if (
                    self._reservation
                    and self._reservation["operation_id"] == operation_id
                ):
                    self._reservation["cancelled"] = True
                    return {"stopping": True}
                if (
                    not isinstance(operation_id, str)
                    or not operation_id
                    or operation_id != self._current_operation_id
                ):
                    return {"stopping": False}
            elif self._current_operation_id is not None:
                return {"stopping": False}
            if self._current_command not in self._STOPPABLE_COMMANDS:
                return {"stopping": False}
            self._stop_requested = True
            if self._active is not None and hasattr(self._active, "stop"):
                self._active.stop()
            return {"stopping": True}

    # ── Helpers ─────────────────────────────────────────────────────────────────
    @staticmethod
    def _require_native_absolute(path, field: str) -> None:
        """Validate desktop paths against the sidecar's own operating system."""
        if not isinstance(path, str) or "\x00" in path or not os.path.isabs(path):
            raise ValueError(f"{field} must be an absolute path for this system")

    #: Keys accepted inside a task's ``options``. Anything else is ignored.
    #: Expanding the client's dict with ``**`` meant an unknown key raised
    #: TypeError deep in the engine and surfaced as a 500 -- a malformed request
    #: reported as a server fault. It also made the accepted surface implicit,
    #: which is the wrong default for a field that arrives over the network.
    _DOWNLOAD_OPTION_KEYS = (
        "save_path",
        "mode",
        "video_fmt",
        "audio_fmt",
        "quality",
        "cookie_file",
        "browser",
        "bitrate",
        # OpenAI-Codex_Fork_Source_Code: preserve single-entry playlist selection.
        "noplaylist",
    )

    @classmethod
    def _task_from_dict(cls, d: dict) -> Task:
        kind = d.get("kind")
        task_id = d.get("task_id")
        task_args = {"task_id": task_id} if isinstance(task_id, str) and task_id else {}
        if kind == "download":
            raw = d.get("options") or {}
            if type(raw.get("noplaylist", False)) is not bool:
                raise ValueError("noplaylist must be a boolean")
            opts = {k: raw[k] for k in cls._DOWNLOAD_OPTION_KEYS if k in raw}
            return Task(
                kind="download",
                label=d.get("label", ""),
                url=d.get("url"),
                options=DownloadOptions(**opts),
                **task_args,
            )
        if kind == "convert":
            return Task(
                kind="convert",
                label=d.get("label", ""),
                src_path=d.get("src_path"),
                dst_path=d.get("dst_path"),
                conflict_policy=d.get("conflict_policy") or "rename",
                video_encoder=d.get("video_encoder", "software"),
                **task_args,
            )
        return Task(kind=kind or "?", label=d.get("label", ""), **task_args)


def main(inp=None, out=None) -> None:
    """Run the stdio event loop. Long-running ops run on worker threads so that
    a ``stop`` request can be received and acted on mid-operation."""
    inp = inp or sys.stdin
    out = out or sys.stdout
    lock = threading.Lock()

    def emit(obj: dict) -> None:
        line = json.dumps(obj, ensure_ascii=False)
        with lock:
            out.write(line + "\n")
            out.flush()

    sidecar = Sidecar(emit)
    workers: list[threading.Thread] = []

    for raw in inp:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            emit({"id": None, "ok": False, "error": "invalid JSON"})
            continue

        cmd = req.get("cmd")
        # State-management requests run inline so their order is preserved.
        if cmd in ("stop", "ping", "prepare", "release", "status"):
            emit(sidecar.dispatch(req))
            continue

        # Long-running commands run on a worker thread; response emitted when done.
        started = threading.Event()
        t = threading.Thread(
            target=lambda r=req, s=started: emit(sidecar.dispatch(r, s)), daemon=True
        )
        t.start()
        # Claim the operation before reading a following stop request.
        started.wait()
        workers.append(t)
        workers = [w for w in workers if w.is_alive()]

    # Drain in-flight work before exiting so no daemon thread races the shutdown.
    for w in workers:
        w.join()


if __name__ == "__main__":
    main()

# Updated by OpenAI-Codex_Fork_Source_Code.
# Updated by OpenAI-Codex_engine_cli.
