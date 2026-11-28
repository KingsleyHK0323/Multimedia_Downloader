# OpenAI-Codex_engine_cli
"""
Converter — wraps ffmpeg for sequential batch transcoding.

Ported from V3.0 ``core.Converter`` with identical behaviour and log keys.
Refactored so a single file can be converted via :meth:`convert_one` (used by
both :meth:`convert_batch` and the AI-driven :class:`engine.queue.TaskQueue`).
The ffmpeg executable name is parameterised for testability / portability.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unicodedata
from functools import wraps
from threading import RLock
from typing import Iterable, Optional

from .errors import ErrorKind, classify
from .formats import HARDWARE_VIDEO_FORMATS, VIDEO_ENCODERS, ensure_known
from .log_safety import redact_sensitive_urls
from .options import ConvertJob, JobUpdateCallback, LogCallback, batch_summary


#: A destination format is a bare extension -- no separators, no dots, no
#: traversal. Anything else means the caller is trying to steer the output path
#: through the format field.
_VALID_FMT = re.compile(r"[A-Za-z0-9]{1,8}")


# OpenAI-Codex_engine_cli: reject concurrent or callback-reentrant operations.
def _exclusive_converter_call(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        if not self._operation_lock.acquire(blocking=False):
            raise RuntimeError("converter already has an active operation")
        owner = False
        try:
            if self._operation_kind is None:
                self._operation_kind = method.__name__
                owner = True
            else:
                context = self._batch_guard_context
                job = args[0] if args else kwargs.get("job")
                if (self._operation_kind != "convert_batch"
                        or method.__name__ != "convert_one"
                        or context is None
                        or context[0] is not job
                        or context[2]["entered"]):
                    raise RuntimeError("converter already has an active operation")
            return method(self, *args, **kwargs)
        finally:
            if owner:
                self._operation_kind = None
            self._operation_lock.release()
    return guarded


# OpenAI-Codex_engine_cli: include canonical-caseless path spellings.
def _include_canonical_casefold(method):
    @wraps(method)
    def guarded(path):
        existing = method(path)
        canonical = unicodedata.normalize("NFD", path).casefold()
        return existing | {unicodedata.normalize(form, canonical) for form in ("NFC", "NFD")}
    return guarded


class Converter:
    """
    Sequentially transcode files using ``ffmpeg``.

    Like :class:`engine.downloader.Downloader`, exposes a stop flag and forwards
    progress through optional callbacks.

    Callbacks
    ---------
    log_cb(level, key, **fmt)
        Forwarded log lines (level: ``info`` | ``ok`` | ``warn`` | ``err``).
    job_update_cb(job)
        Called whenever a job's status changes.
    """

    def __init__(
        self,
        save_path:     str,
        dst_fmt:       str,
        log_cb:        Optional[LogCallback]       = None,
        job_update_cb: Optional[JobUpdateCallback] = None,
        ffmpeg_bin:    str = "ffmpeg",
        conflict_policy: str = "rename",
        protected_paths: Optional[Iterable[str]] = None,
        video_encoder: str = "software",
    ) -> None:
        if conflict_policy not in ("rename", "skip", "overwrite"):
            raise ValueError("conflict_policy must be rename, skip, or overwrite")
        video_encoder = ensure_known(video_encoder, VIDEO_ENCODERS, "video encoder")
        if video_encoder != "software" and (
                not isinstance(dst_fmt, str)
                or dst_fmt.lower() not in HARDWARE_VIDEO_FORMATS):
            raise ValueError(
                f"{video_encoder} supports only {', '.join(HARDWARE_VIDEO_FORMATS)} output"
            )
        self.save_path     = save_path
        self.dst_fmt       = dst_fmt
        self.log_cb        = log_cb
        self.job_update_cb = job_update_cb
        self.ffmpeg_bin    = ffmpeg_bin
        # OpenAI-Codex_Fork_Source_Code: hardware is explicit; no detection or fallback.
        self.video_encoder = video_encoder
        self.conflict_policy = conflict_policy
        self._stop         = False
        self._protected_paths: set[str] = set()
        for path in protected_paths or ():
            self._protected_paths.update(self._identities(path))
        # OpenAI-Codex_Fork_Source_Code: keep explicit inputs separate from prior batches.
        self._configured_protected_paths = set(self._protected_paths)
        self._batch_guard_context = None
        self._legacy_batch_guard = None
        # OpenAI-Codex_engine_cli: serialize one instance without blocking callers.
        self._operation_lock = RLock()
        self._operation_kind = None
        self.last_summary = batch_summary(0, 0, 0, False)

    # ── Public ──────────────────────────────────────────────────────────────
    def stop(self) -> None:
        self._stop = True

    def make_job(self, src: str) -> ConvertJob:
        """
        Build a :class:`ConvertJob` mapping ``src`` to a dst in ``save_path``.

        ``dst_fmt`` is validated here rather than by the caller because this is
        where the destination path is actually assembled. A caller that checks
        its inputs and then hands them to a function that composes a path from
        them has only moved the problem: the web backend confined `save_path`
        and the source list, and a `dst_fmt` of "../../x.mp4" still walked out
        of the confined directory, because the escape was assembled after the
        check. Validate where the path is built, not where it is received.

        Batch frontends go through here; direct queue jobs also validate the
        actual destination extension in ``convert_one``.
        """
        if not _VALID_FMT.fullmatch(self.dst_fmt or ""):
            raise ValueError(
                f"invalid output format {self.dst_fmt!r}: expected a bare "
                "extension such as 'mp4' or 'mp3'"
            )
        base = os.path.splitext(os.path.basename(src))[0]
        return ConvertJob(
            src_path=src,
            dst_path=os.path.join(self.save_path, f"{base}.{self.dst_fmt}"),
        )

    def preview_batch(self, src_files: Iterable[str]) -> list[dict]:
        """Inspect conventionally named destinations without modifying files."""
        sources = list(src_files)
        return self.preview_jobs([self.make_job(src) for src in sources])

    # OpenAI-Codex_web_ai: preserve explicit queue destinations in previews.
    @classmethod
    def preview_jobs(cls, jobs: Iterable[ConvertJob]) -> list[dict]:
        """Inspect explicit destinations without creating or modifying files.

        The returned states are a snapshot, not a reservation of output names.
        A possible duplicate or an unknown source match is intentionally
        conservative when a filesystem identity cannot be established.
        """
        jobs = list(jobs)
        sources = [job.src_path for job in jobs]
        states = []
        identities = []
        for job in jobs:
            try:
                os.lstat(job.dst_path)
                existing = "exists"
            except FileNotFoundError:
                existing = "missing"
            except (OSError, ValueError, TypeError, NotImplementedError):
                existing = "unknown"
            states.append(existing)
            try:
                if existing == "unknown":
                    raise ValueError("destination identity is unknown")
                if existing == "exists":
                    os.stat(job.dst_path)
                identities.append(cls._identities(job.dst_path))
            except (OSError, ValueError, TypeError, NotImplementedError):
                identities.append(None)

        previews = []
        for index, job in enumerate(jobs):
            matches = "no"
            for source in sources:
                try:
                    # OpenAI-Codex_engine_cli: uncertain aliases must not report no.
                    if not cls._identities(source).isdisjoint(cls._identities(job.dst_path)):
                        matches = "unknown"
                    same_path = (os.path.normcase(os.path.abspath(source))
                                 == os.path.normcase(os.path.abspath(job.dst_path)))
                    # OpenAI-Codex_engine_cli: case-folded equality is not proof of identity.
                    if os.path.abspath(source) != os.path.abspath(job.dst_path):
                        same_path = False
                    if same_path:
                        matches = "yes"
                        break
                    if states[index] == "unknown":
                        matches = "unknown"
                    elif states[index] == "missing":
                        os.stat(source)
                    elif os.path.samefile(source, job.dst_path):
                        matches = "yes"
                        break
                except (OSError, ValueError, TypeError, NotImplementedError):
                    matches = "unknown"
            possible_duplicate = any(
                index != other and (identity is None or identities[index] is None
                                    or not identities[index].isdisjoint(identity))
                for other, identity in enumerate(identities)
            )
            previews.append({"src": job.src_path, "dst": job.dst_path,
                             "existing": states[index], "batch_duplicate": possible_duplicate,
                             "source_matches": matches})
        return previews

    # OpenAI-Codex_engine_cli: keep batch context stable during single jobs.
    @_exclusive_converter_call
    def convert_one(self, job: ConvertJob, index: int = 1, total: int = 1) -> ConvertJob:
        """
        Run ffmpeg on a single job, updating its status in place. Failures are
        recorded on the job; a collision or cancellation can mark it skipped.
        """
        # OpenAI-Codex_Fork_Source_Code: reject same-instance callback reentry.
        active_batch = self._batch_guard_context
        if active_batch is not None:
            if active_batch[0] is not job or active_batch[2]["entered"]:
                raise RuntimeError("converter already has an active batch")
            active_batch[2]["entered"] = True
        if self._stop:
            self._set_status(job, "skipped")
            return job

        self._log("info", "log_convert_start",
                  i=index, t=total,
                  src=os.path.basename(job.src_path),
                  dst=os.path.basename(job.dst_path))
        self._set_status(job, "converting")

        temporary = None
        try:
            extension = os.path.splitext(job.dst_path)[1].lstrip(".")
            if not _VALID_FMT.fullmatch(extension):
                raise ValueError("destination must have a bare format extension")
            if (self.video_encoder != "software"
                    and extension.lower() not in HARDWARE_VIDEO_FORMATS):
                raise ValueError(
                    f"{self.video_encoder} supports only {', '.join(HARDWARE_VIDEO_FORMATS)} output"
                )

            protected = self._protected_paths | self._identities(job.src_path)
            # OpenAI-Codex_Fork_Source_Code: guard only the active direct-batch job.
            context = self._batch_guard_context
            batch_guard = (context[1] | self._identities(job.src_path)
                           if context is not None and context[0] is job else None)
            if batch_guard is not None and not self._identities(job.dst_path).isdisjoint(batch_guard):
                if self.conflict_policy == "overwrite":
                    raise ValueError("refusing to publish to a protected input path")
                if (self.conflict_policy == "skip"
                        and self._identities(job.dst_path).isdisjoint(self._identities(job.src_path))
                        # OpenAI-Codex_Fork_Source_Code: missing inputs still report failure.
                        and os.path.lexists(job.src_path)
                        # OpenAI-Codex_Fork_Source_Code: a dangling source must still fail.
                        and os.path.exists(job.src_path)):
                    self._set_status(job, "skipped")
                    return job
            if self.conflict_policy == "skip" and os.path.lexists(job.dst_path):
                self._set_status(job, "skipped")
                return job
            if (self.conflict_policy == "overwrite"
                    and not self._identities(job.dst_path).isdisjoint(protected)
                    and os.path.lexists(job.dst_path)):
                raise ValueError("refusing to overwrite an input file")

            directory = os.path.dirname(os.path.abspath(job.dst_path))
            # OpenAI-Codex: publish on the same filesystem as the destination.
            fd, temporary = tempfile.mkstemp(prefix=".mmdl-", suffix="." + extension, dir=directory)
            os.close(fd)
            try:
                # ffmpeg writes only to our fresh temporary file, never directly
                # to an existing destination. Arguments are not passed to a shell.
                command = [self.ffmpeg_bin, "-y", "-i", job.src_path]
                if self.video_encoder != "software":
                    command.extend(["-c:v", self.video_encoder])
                command.extend(["-loglevel", "error", temporary])
                process = subprocess.Popen(  # noqa: S603
                    command, stderr=subprocess.PIPE, text=True,
                )
                stderr_parts: list[str] = []
                if process.stderr:
                    for line in process.stderr:
                        stderr_parts.append(line)
                        if self.log_cb:
                            self.log_cb("info", "log_ffmpeg_stderr", line=line.rstrip())
                process.wait()
                stderr = "".join(stderr_parts)
                result = type("FFmpegResult", (), {"returncode": process.returncode, "stderr": stderr})()
            except FileNotFoundError as e:
                self._log("err", "log_no_ffmpeg", i=index, t=total)
                self._set_status(job, "no_ffmpeg", error="ffmpeg not found", kind=classify(e))
                return job

            if result.returncode != 0:
                raise RuntimeError(stderr[:300] or "ffmpeg error (no output)")

            # OpenAI-Codex_Fork_Source_Code: retain ordinary single-job behavior.
            if batch_guard is not None:
                # OpenAI-Codex_Fork_Source_Code: preserve three-argument overrides.
                if getattr(self._publish, "__func__", None) is not Converter._publish:
                    previous_legacy_guard = self._legacy_batch_guard
                    self._legacy_batch_guard = batch_guard
                    try:
                        published, moved = self._publish(temporary, job.dst_path, protected)
                    finally:
                        self._legacy_batch_guard = previous_legacy_guard
                else:
                    published, moved = self._publish(temporary, job.dst_path, protected, batch_guard=batch_guard)
            else:
                published, moved = self._publish(temporary, job.dst_path, protected)
            if published is None:
                self._set_status(job, "skipped")
            else:
                if moved:
                    temporary = None  # os.replace moved it into place
                job.dst_path = published
                self._log("ok", "log_convert_done",
                          i=index, t=total, name=os.path.basename(job.dst_path))
                self._set_status(job, "done")

        except Exception as e:
            self._log("err", "log_convert_error", i=index, t=total, err=str(e))
            # A missing output directory is not a missing ffmpeg executable.
            kind = ErrorKind.UNKNOWN if isinstance(e, FileNotFoundError) else classify(e)
            self._set_status(job, "error", error=str(e), kind=kind)
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    self._log("warn", "log_convert_error", i=index, t=total,
                              err="temporary output disappeared before cleanup")
                except OSError as e:
                    self._log("warn", "log_convert_error", i=index, t=total,
                              err=f"temporary output could not be removed: {e}")

        return job

    # OpenAI-Codex_engine_cli: claim the instance before iterating source paths.
    @_exclusive_converter_call
    def convert_batch(self, src_files: Iterable[str]) -> list[ConvertJob]:
        """Run ffmpeg on each file. Returns the list of jobs with final status."""
        # OpenAI-Codex_Fork_Source_Code: one Converter cannot run nested batches.
        if self._batch_guard_context is not None:
            raise RuntimeError("converter already has an active batch")
        sources = list(src_files)
        jobs = [self.make_job(src) for src in sources]
        if self.conflict_policy == "overwrite" and not self._stop:
            destinations: set[str] = set()
            for job in jobs:
                identities = self._identities(job.dst_path)
                if not identities.isdisjoint(destinations) and not self._stop:
                    raise ValueError("overwrite cannot target the same destination for multiple files")
                destinations.update(identities)
        # OpenAI-Codex_Fork_Source_Code: do not reserve paths from earlier batches.
        batch_protected_paths = set(self._configured_protected_paths)
        for source in sources:
            self._protected_paths.update(self._identities(source))
            batch_protected_paths.update(self._identities(source))
        total = len(jobs)

        for i, job in enumerate(jobs, start=1):
            if self._stop:
                self._log("warn", "log_convert_stopped")
                for pending in jobs[i - 1:]:
                    self._set_status(pending, "skipped")
                break
            # OpenAI-Codex_Fork_Source_Code: restore scope on callback or worker errors.
            previous_context = self._batch_guard_context
            self._batch_guard_context = (job, batch_protected_paths, {"entered": False})
            try:
                self.convert_one(job, index=i, total=total)
            finally:
                self._batch_guard_context = previous_context

        ok = sum(1 for j in jobs if j.status == "done")
        fail = sum(1 for j in jobs if j.status in ("error", "no_ffmpeg"))
        self.last_summary = batch_summary(total, ok, fail, self._stop)
        if fail == 0 and self.last_summary["skipped"] == 0 and not self._stop:
            self._log("ok", "log_all_converted", t=total)
        elif fail and ok == 0:
            self._log("err", "log_all_convert_failed", t=fail)
        elif fail:
            self._log("warn", "log_all_converted_partial",
                      ok=ok, fail=fail, t=total)
        return jobs

    # ── Internal ──────────────────────────────────────────────────────────────
    @staticmethod
    def _identity(path: str) -> str:
        return os.path.normcase(os.path.realpath(os.path.abspath(path)))

    # OpenAI-Codex_engine_cli: preserve exact spellings for dependency decisions.
    @staticmethod
    def _exact_identities(path: str) -> set[str]:
        absolute = os.path.abspath(path)
        return {absolute, os.path.realpath(absolute)}

    # OpenAI-Codex_engine_cli: treat common case and Unicode aliases conservatively.
    @staticmethod
    @_include_canonical_casefold
    def _conservative_spellings(path: str) -> set[str]:
        folded = path.casefold()
        return {unicodedata.normalize(form, folded) for form in ("NFC", "NFD")}

    @classmethod
    def _identities(cls, path: str) -> set[str]:
        """Keep both the stable path spelling and its current resolved target."""
        # OpenAI-Codex_engine_cli: POSIX normcase may not reflect the mounted volume.
        exact = {os.path.normcase(os.path.abspath(path)), cls._identity(path)}
        return exact | {folded for item in exact for folded in cls._conservative_spellings(item)}
        return {os.path.normcase(os.path.abspath(path)), cls._identity(path)}

    def _publish(self, temporary: str, desired: str,
                 protected: set[str], *, batch_guard: Optional[set[str]] = None) -> tuple[Optional[str], bool]:
        """Atomically publish without overwriting unless explicitly requested.

        No-replace publication requires same-filesystem hard-link support; an
        unsupported filesystem raises instead of falling back to unsafe copying.
        """
        if batch_guard is None:
            batch_guard = self._legacy_batch_guard
        # OpenAI-Codex_Fork_Source_Code: recheck reserved destinations before publication.
        if batch_guard is not None and not self._identities(desired).isdisjoint(batch_guard):
            if self.conflict_policy == "skip":
                return None, False
            if self.conflict_policy == "overwrite":
                raise ValueError("refusing to publish to a protected input path")
        protected_overwrite = (self.conflict_policy == "overwrite"
                               and not self._identities(desired).isdisjoint(protected))
        if self.conflict_policy == "overwrite" and not protected_overwrite:
            os.replace(temporary, desired)
            return desired, True

        stem, extension = os.path.splitext(desired)
        index = 0
        while True:
            candidate = desired if index == 0 else f"{stem} ({index}){extension}"
            if (batch_guard is not None and index == 0
                    and not self._identities(candidate).isdisjoint(batch_guard)):
                index += 1
                continue
            if index and not self._identities(candidate).isdisjoint(batch_guard if batch_guard is not None else protected):
                index += 1
                continue
            try:
                os.link(temporary, candidate)
                return candidate, False
            except FileExistsError:
                if self.conflict_policy == "skip":
                    return None, False
                if protected_overwrite:
                    raise ValueError("refusing to overwrite an input file") from None
                index += 1
            except OSError as e:
                raise OSError(
                    "cannot safely publish without overwriting; the destination "
                    "filesystem must support hard links and permit their creation"
                ) from e

    def _set_status(self, job: ConvertJob, status: str, error: str = "",
                    kind: ErrorKind | None = None) -> None:
        job.status = status
        if error:
            job.error = redact_sensitive_urls(error)
        if kind is not None:
            job.error_kind = kind.value
        if self.job_update_cb:
            self.job_update_cb(job)

    def _log(self, level: str, key: str, **fmt) -> None:
        if self.log_cb:
            safe = {name: redact_sensitive_urls(value) if isinstance(value, str) else value
                    for name, value in fmt.items()}
            self.log_cb(level, key, **safe)
