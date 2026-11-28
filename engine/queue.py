# OpenAI-Codex_engine_cli
"""
TaskQueue — a unified, inspectable queue of download + convert operations.

This is the NEW V4.0 capability that serves the AI assistant's
"advise -> confirm -> execute" model (decision D4): the AI produces a plan as a
list of :class:`Task` objects, the user reviews it, and only then does
:meth:`TaskQueue.run` execute them sequentially, reporting per-task status and
honouring a cooperative stop flag.

Each task delegates to the same :class:`~engine.downloader.Downloader` /
:class:`~engine.converter.Converter` used elsewhere, so behaviour stays
identical — the queue only orchestrates ordering, status, and cancellation.
"""

from __future__ import annotations

import inspect
import os
import stat
from dataclasses import dataclass, field
from functools import wraps
from threading import Lock
from typing import Callable, Optional
from uuid import uuid4

from .converter import Converter
from .errors import ErrorKind, OperationCancelled, classify
from .downloader import Downloader
from .formats import HARDWARE_VIDEO_FORMATS, VIDEO_ENCODERS, ensure_known
from .log_safety import redact_sensitive_urls
from .options import ConvertJob, DownloadOptions, LogCallback, batch_summary

#: ``(task) -> None`` — a Task whose status just changed
TaskUpdateCallback = Callable[["Task"], None]

DOWNLOAD = "download"
CONVERT = "convert"


@dataclass
class Task:
    """
    One unit of work in a :class:`TaskQueue`.

    ``kind`` selects which fields are meaningful:
    * ``"download"`` uses ``url`` + ``options``
    * ``"convert"``  uses ``src_path`` + ``dst_path``
    """

    kind: str
    label: str = ""
    status: str = "pending"  # pending | running | done | error | skipped
    error: str = ""
    #: str value of an :class:`engine.errors.ErrorKind`; "" while not failed.
    #: Named error_kind, not kind -- ``kind`` above already means the task type
    #: ("download"/"convert") and crosses the IPC boundary under that name.
    error_kind: str = ""
    # download
    url: Optional[str] = None
    options: Optional[DownloadOptions] = None
    # convert
    src_path: Optional[str] = None
    dst_path: Optional[str] = None
    task_id: str = field(default_factory=lambda: str(uuid4()))
    conflict_policy: str = "rename"
    # OpenAI-Codex_Fork_Source_Code: preserve explicit encoder choice per task.
    video_encoder: str = "software"

    def __post_init__(self) -> None:
        if not isinstance(self.task_id, str) or not self.task_id.strip():
            raise ValueError("task_id must be a non-empty string")
        if self.conflict_policy not in ("rename", "skip", "overwrite"):
            raise ValueError("conflict_policy must be rename, skip, or overwrite")
        self.video_encoder = ensure_known(
            self.video_encoder, VIDEO_ENCODERS, "video encoder"
        )
        if self.video_encoder != "software":
            extension = (
                os.path.splitext(self.dst_path)[1].lstrip(".").lower()
                if isinstance(self.dst_path, str)
                else ""
            )
            if extension not in HARDWARE_VIDEO_FORMATS:
                raise ValueError(
                    f"{self.video_encoder} supports only {', '.join(HARDWARE_VIDEO_FORMATS)} output"
                )


# ── Task factories — the clean way for a planner to build a plan ──────────────


def download_task(url: str, options: DownloadOptions, label: str = "") -> Task:
    return Task(kind=DOWNLOAD, url=url, options=options, label=label or url)


def convert_task(
    src_path: str,
    dst_path: str,
    label: str = "",
    conflict_policy: str = "rename",
    video_encoder: str = "software",
) -> Task:
    return Task(
        kind=CONVERT,
        src_path=src_path,
        dst_path=dst_path,
        label=label or os.path.basename(src_path),
        conflict_policy=conflict_policy,
        video_encoder=video_encoder,
    )


# OpenAI-Codex_engine_cli: reject concurrent and callback-reentrant queue runs.
def _exclusive_queue_run(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        if not self._run_lock.acquire(blocking=False):
            raise RuntimeError("queue already has an active operation")
        try:
            return method(self, *args, **kwargs)
        except BaseException as callback_error:
            # OpenAI-Codex_engine_cli: finalize only the failing task callback.
            if callback_error is self._task_update_error:
                self._task_update_error = None
                try:
                    self._finish_task_update_error(args[0] if args else kwargs["tasks"])
                except BaseException as cleanup_error:
                    raise callback_error from cleanup_error
            # OpenAI-Codex_engine_cli: reconcile other failures after iteration begins.
            elif self._task_loop_started:
                try:
                    self._finish_task_run_error(args[0] if args else kwargs["tasks"])
                except BaseException as cleanup_error:
                    raise callback_error from cleanup_error
            raise
        finally:
            # OpenAI-Codex_engine_cli: do not carry run state into another call.
            self._task_loop_started = False
            # OpenAI-Codex: consume this run's cancellation after recording its summary.
            self._stop = False
            self._run_lock.release()

    return guarded


class TaskQueue:
    """
    Sequentially execute a reviewed list of :class:`Task` objects.

    Callbacks
    ---------
    log_cb(level, key, **fmt)
        Queue-level log lines plus the delegated download/convert lines.
    task_update_cb(task)
        Called whenever a task's status changes.
    """

    def __init__(
        self,
        log_cb: Optional[LogCallback] = None,
        task_update_cb: Optional[TaskUpdateCallback] = None,
        ffmpeg_bin: str = "ffmpeg",
    ) -> None:
        self.log_cb = log_cb
        self.task_update_cb = task_update_cb
        # OpenAI-Codex_engine_cli: track the precise callback exception.
        self._task_update_error = None
        # OpenAI-Codex_engine_cli: preflight is outside the task iteration.
        self._task_loop_started = False
        self.ffmpeg_bin = ffmpeg_bin
        # OpenAI-Codex_engine_cli: share one nonblocking guard per queue.
        self._run_lock = Lock()
        self._stop = False
        self._active: Optional[Downloader | Converter] = None
        self._protected_paths: list[str] = []
        self.last_summary = batch_summary(0, 0, 0, False)

    def stop(self) -> None:
        """Request cooperative cancellation. Pending tasks become ``skipped``."""
        self._stop = True
        active = self._active
        if active is not None:
            active.stop()

    @_exclusive_queue_run
    def run(self, tasks: list[Task]) -> list[Task]:
        """Execute every task in order. Returns the same list with final status."""
        # OpenAI-Codex_engine_cli: do not reuse an earlier callback exception.
        self._task_update_error = None
        # OpenAI-Codex_engine_cli: preflight failures keep existing task states.
        self._task_loop_started = False
        ids = [task.task_id for task in tasks]
        if len(ids) != len(set(ids)):
            raise ValueError("task_id values must be unique within a queue")
        if not self._stop:
            self._validate_plan(tasks)
        self._protected_paths = [
            task.src_path for task in tasks if task.kind == CONVERT and task.src_path
        ]
        total = len(tasks)
        self._log("info", "log_queue_start", n=total)

        stop_logged = False
        ambiguous_outputs: set[str] = set()
        for i, task in enumerate(tasks, start=1):
            # OpenAI-Codex_engine_cli: reconcile only after an item iteration begins.
            self._task_loop_started = True
            if self._stop:
                for rest in tasks[i - 1 :]:
                    if rest.status == "pending":
                        self._set_status(rest, "skipped")
                self._log("warn", "log_queue_stopped")
                stop_logged = True
                break

            planned_destination = task.dst_path if task.kind == CONVERT else None
            if (
                task.kind == CONVERT
                and task.src_path
                and not Converter._identities(task.src_path).isdisjoint(
                    ambiguous_outputs
                )
            ):
                self._set_status(
                    task,
                    "skipped",
                    "ambiguous dependency: an earlier conversion did not produce the planned input",
                )
            else:
                self._run_task(task, i, total)

            if planned_destination:
                planned_identities = Converter._identities(planned_destination)
                if (
                    task.status == "done"
                    and task.dst_path
                    and not Converter._identities(task.dst_path).isdisjoint(
                        planned_identities
                    )
                ):
                    ambiguous_outputs.difference_update(planned_identities)
                else:
                    ambiguous_outputs.update(planned_identities)
        if self._stop and not stop_logged:
            self._log("warn", "log_queue_stopped")
        ok = sum(1 for task in tasks if task.status == "done")
        fail = sum(1 for task in tasks if task.status == "error")
        self.last_summary = batch_summary(total, ok, fail, self._stop)
        level = "warn" if fail or self.last_summary["skipped"] or self._stop else "ok"
        self._log(level, "log_queue_done", ok=ok, fail=fail, t=total)
        return tasks

    # ── Internal ──────────────────────────────────────────────────────────────
    @staticmethod
    def _validate_plan(tasks: list[Task]) -> None:
        """Reject ambiguous dependencies and conflicting overwrites."""
        # OpenAI-Codex_engine_cli: reject detectable existing file aliases.
        prior_conversion_destinations: list[str] = []
        for candidate_task in tasks:
            if candidate_task.kind != CONVERT:
                continue
            if candidate_task.src_path:
                for prior_destination in prior_conversion_destinations:
                    try:
                        same_file = os.path.samefile(
                            candidate_task.src_path, prior_destination
                        )
                    except FileNotFoundError:
                        continue
                    except (
                        OSError,
                        TypeError,
                        ValueError,
                        AttributeError,
                        NotImplementedError,
                    ):
                        raise ValueError(
                            "cannot safely determine existing conversion dependencies; "
                            "run conversions separately"
                        ) from None
                    if same_file:
                        raise ValueError(
                            "ambiguous dependency: an earlier conversion destination and later source "
                            "refer to the same existing file"
                        )
            if candidate_task.dst_path:
                prior_conversion_destinations.append(candidate_task.dst_path)

        destinations: dict[str, list[tuple[str, str, str]]] = {}
        download_directories: list[Optional[str]] = []
        for task in tasks:
            if task.kind == DOWNLOAD:
                download_directories.append(getattr(task.options, "save_path", None))
                continue
            if task.kind != CONVERT:
                continue
            if task.src_path:
                if any(
                    TaskQueue._download_may_contain_source(directory, task.src_path)
                    for directory in download_directories
                ):
                    raise ValueError(
                        "ambiguous dependency: a prior download may produce this source; "
                        "run downloads and conversions separately"
                    )
                producers = [
                    entry
                    for source_id in Converter._identities(task.src_path)
                    for entry in destinations.get(source_id, [])
                ]
                # OpenAI-Codex_engine_cli: a folded alias is not a declared dependency.
                source_exact = Converter._exact_identities(task.src_path)
                if any(
                    Converter._exact_identities(path).isdisjoint(source_exact)
                    for path, _, _ in producers
                ):
                    raise ValueError(
                        "ambiguous dependency: source and destination may be aliases"
                    )
                if len({task_id for _, _, task_id in producers}) > 1:
                    raise ValueError(
                        "ambiguous dependency: multiple earlier conversions target this source"
                    )
                if any(os.path.lexists(path) for path, _, _ in producers):
                    raise ValueError(
                        "ambiguous dependency: an earlier conversion destination already exists"
                    )
            if task.dst_path:
                destination_ids = Converter._identities(task.dst_path)
                for destination_id in destination_ids:
                    previous = destinations.get(destination_id, [])
                    if previous and (
                        task.conflict_policy == "overwrite"
                        or any(policy == "overwrite" for _, policy, _ in previous)
                    ):
                        raise ValueError(
                            "overwrite cannot target the same destination for multiple tasks"
                        )
                for destination_id in destination_ids:
                    destinations.setdefault(destination_id, []).append(
                        (task.dst_path, task.conflict_policy, task.task_id)
                    )

    @staticmethod
    def _download_may_contain_source(directory: Optional[str], source: str) -> bool:
        """Check lexical and resolved paths without assuming a download output name."""
        try:

            def audited_realpath(absolute: str) -> str:
                resolved = os.path.normcase(os.path.abspath(os.path.realpath(absolute)))
                if not os.path.isabs(resolved):
                    raise ValueError("resolved path is not absolute")

                def audit(path: str) -> None:
                    parts = []
                    current = path
                    while True:
                        parent = os.path.dirname(current)
                        if parent == current:
                            break
                        if not parent:
                            raise ValueError("path root cannot be determined")
                        parts.append(current)
                        current = parent
                    prefixes = [current] + list(reversed(parts))
                    for index, prefix in enumerate(prefixes):
                        try:
                            info = os.lstat(prefix)
                        except FileNotFoundError:
                            if index == 0:
                                raise
                            break
                        if index == 0 and not stat.S_ISDIR(info.st_mode):
                            raise ValueError("path root is not a directory")
                        is_link = stat.S_ISLNK(info.st_mode) or bool(
                            getattr(info, "st_file_attributes", 0) & 0x400
                        )
                        if is_link:
                            os.stat(prefix)
                            link_target = os.path.normcase(
                                os.path.abspath(os.path.realpath(prefix))
                            )
                            if link_target == os.path.normcase(
                                os.path.abspath(prefix)
                            ) or not os.path.samefile(prefix, link_target):
                                raise ValueError("link target cannot be verified")

                audit(absolute)
                audit(resolved)
                return resolved

            def identities(path: str) -> tuple[str, str]:
                absolute = os.path.normcase(os.path.abspath(path))
                if not os.path.isabs(absolute):
                    raise ValueError("path is not absolute")
                try:
                    resolved = os.path.realpath(absolute, strict=True)
                except FileNotFoundError:
                    # Missing planned inputs are safe only if all existing links resolve.
                    resolved = audited_realpath(absolute)
                except TypeError:
                    try:
                        inspect.signature(os.path.realpath).bind(absolute, strict=True)
                    except TypeError:
                        resolved = audited_realpath(absolute)
                    else:
                        raise
                resolved = os.path.normcase(os.path.abspath(resolved))
                if not os.path.isabs(resolved):
                    raise ValueError("resolved path is not absolute")
                return absolute, resolved

            directories = identities(directory)
            sources = identities(source)
            for root, candidate in zip(directories, sources):
                root_drive, _ = os.path.splitdrive(root)
                candidate_drive, _ = os.path.splitdrive(candidate)
                if root_drive != candidate_drive:
                    if root_drive and candidate_drive:
                        continue
                    raise ValueError("path drive cannot be determined")
                # OpenAI-Codex_engine_cli: POSIX volumes may ignore path case.
                for folded_root in Converter._conservative_spellings(root):
                    for folded_candidate in Converter._conservative_spellings(
                        candidate
                    ):
                        if (
                            os.path.commonpath([folded_root, folded_candidate])
                            == folded_root
                        ):
                            return True
                if os.path.commonpath([root, candidate]) == root:
                    return True
            return False
        except (OSError, TypeError, ValueError) as exc:
            raise ValueError(
                "cannot safely determine download/conversion dependencies; "
                "run downloads and conversions separately"
            ) from exc

    def _run_task(self, task: Task, index: int, total: int) -> None:
        self._set_status(task, "running")

        if task.kind == DOWNLOAD:
            if not task.url or task.options is None:
                self._set_status(task, "error", "download task missing url/options")
                return
            dl = Downloader(task.options, log_cb=self.log_cb)
            self._active = dl
            try:
                # OpenAI-Codex: release the active operation even if stop fails.
                if self._stop:
                    dl.stop()
                try:
                    dl.download_one_with_retry(task.url, index=index, total=total)
                    self._set_status(task, "done")
                except OperationCancelled as _cancelled:
                    # OpenAI-Codex_engine_cli: a callback exception is not a cancellation.
                    if self._task_update_error is _cancelled:
                        raise
                    # OpenAI-Codex_engine_cli: explicit cancellation stops the queue.
                    self._stop = True
                    self._set_status(task, "skipped")
                except Exception as e:
                    # OpenAI-Codex_engine_cli: preserve the original callback exception.
                    if self._task_update_error is e:
                        raise
                    self._set_status(task, "error", str(e), kind=classify(e))
            finally:
                self._active = None

        elif task.kind == CONVERT:
            if not task.src_path or not task.dst_path:
                self._set_status(task, "error", "convert task missing src/dst path")
                return
            conv = Converter(
                save_path=os.path.dirname(task.dst_path),
                dst_fmt=os.path.splitext(task.dst_path)[1].lstrip("."),
                log_cb=self.log_cb,
                ffmpeg_bin=self.ffmpeg_bin,
                conflict_policy=task.conflict_policy,
                protected_paths=self._protected_paths,
                video_encoder=task.video_encoder,
            )
            self._active = conv
            try:
                # OpenAI-Codex: include setup in the active-operation lifetime.
                if self._stop:
                    conv.stop()
                job = ConvertJob(src_path=task.src_path, dst_path=task.dst_path)
                conv.convert_one(job, index=index, total=total)
            finally:
                self._active = None
            if job.status == "done":
                task.dst_path = job.dst_path
                self._set_status(task, "done")
            elif job.status == "skipped":
                self._set_status(task, "skipped")
            else:
                # The Converter already classified it; carry that across rather
                # than re-deriving it from the message it happened to record.
                task.error_kind = job.error_kind
                self._set_status(task, "error", job.error)

        else:
            self._set_status(task, "error", f"unknown task kind: {task.kind!r}")

    # OpenAI-Codex_engine_cli: finalize interrupted runs without calling callbacks.
    def _finish_task_run_error(self, tasks: list[Task]) -> None:
        for task in tasks:
            if task.status == "running":
                task.status = "error"
                task.error = "Task execution interrupted; the task outcome is unknown."
                task.error_kind = ErrorKind.UNKNOWN.value
            elif task.status == "pending":
                task.status = "skipped"
        succeeded = sum(1 for task in tasks if task.status == "done")
        failed = sum(1 for task in tasks if task.status == "error")
        self.last_summary = batch_summary(len(tasks), succeeded, failed, self._stop)

    # OpenAI-Codex_engine_cli: finalize callback failures without reentering callbacks.
    def _finish_task_update_error(self, tasks: list[Task]) -> None:
        for task in tasks:
            if task.status == "running":
                task.status = "error"
                task.error = "Task update callback failed; the task outcome is unknown."
                task.error_kind = ErrorKind.UNKNOWN.value
            elif task.status == "pending":
                task.status = "skipped"
        succeeded = sum(1 for task in tasks if task.status == "done")
        failed = sum(1 for task in tasks if task.status == "error")
        self.last_summary = batch_summary(len(tasks), succeeded, failed, self._stop)

    def _set_status(
        self, task: Task, status: str, error: str = "", kind: ErrorKind | None = None
    ) -> None:
        task.status = status
        if error:
            task.error = redact_sensitive_urls(error)
        if kind is not None:
            task.error_kind = kind.value
        if self.task_update_cb:
            # OpenAI-Codex_engine_cli: identify callback exceptions by identity.
            try:
                self.task_update_cb(task)
            except BaseException as callback_error:
                self._task_update_error = callback_error
                raise
            else:
                self._task_update_error = None

    def _log(self, level: str, key: str, **fmt) -> None:
        if self.log_cb:
            safe = {
                name: redact_sensitive_urls(value) if isinstance(value, str) else value
                for name, value in fmt.items()
            }
            self.log_cb(level, key, **safe)
