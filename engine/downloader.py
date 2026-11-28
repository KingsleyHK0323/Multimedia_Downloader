# OpenAI-Codex_engine_cli
"""
Downloader — orchestrates one or more downloads using yt-dlp.

Ported from V3.0 ``core.Downloader`` with identical behaviour and log keys.
Refactored so a single URL can be downloaded via :meth:`download_one` (used by
both :meth:`download_batch` and the AI-driven :class:`engine.queue.TaskQueue`).
"""

from __future__ import annotations

import math
import os
import re
import shutil
import time
from itertools import islice
from typing import Iterable, Optional
from urllib.parse import quote, urlsplit

import yt_dlp

from .errors import ErrorKind, OperationCancelled, classify, is_stale_tool
from .formats import (
    AUDIO_FORMATS,
    QUALITY_PRESETS,
    VIDEO_FORMATS,
    build_ydl_format_string,
    ensure_known,
    platform_headers,
)
from .log_safety import redact_sensitive_urls
from .options import (
    DownloadOptions,
    ItemStartCallback,
    LogCallback,
    ProgressCallback,
    batch_summary,
)

#: How many extra attempts a transient failure gets, and how long to wait
#: between them. Kept short: the delay is user-visible in the Run Log.
_MAX_RETRIES = 2
_RETRY_DELAY_S = 2
# OpenAI-Codex_Fork_Source_Code: cap metadata-only playlist previews.
_PLAYLIST_PREVIEW_LIMIT = 500


# OpenAI-Codex: consume documented progress fields even without a formatted percentage.
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def _progress_number(value: object) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _progress_text(value: object) -> str:
    return _ANSI_ESCAPE.sub("", value).strip() if isinstance(value, str) else ""


def _download_progress(data: dict) -> tuple[float, str, str]:
    percent = _progress_number(data.get("_percent"))
    downloaded = _progress_number(data.get("downloaded_bytes"))
    total = _progress_number(data.get("total_bytes"))
    if total is None or total == 0:
        total = _progress_number(data.get("total_bytes_estimate"))
    if percent is None and downloaded is not None and total:
        percent = min(100.0, downloaded / total * 100.0)
    if percent is None:
        try:
            percent = _progress_number(
                float(_progress_text(data.get("_percent_str")).rstrip("%"))
            )
        except ValueError:
            pass

    speed = _progress_text(data.get("_speed_str"))
    raw_speed = _progress_number(data.get("speed"))
    if not speed or speed.casefold() in {"n/a", "unknown", "--"}:
        speed = "--"
        if raw_speed is not None:
            amount = raw_speed
            for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
                if amount < 1024 or unit == "TiB":
                    speed = f"{amount:.2f}{unit}/s"
                    break
                amount /= 1024

    eta = _progress_text(data.get("_eta_str"))
    raw_eta = _progress_number(data.get("eta"))
    if not eta or eta.casefold() in {"n/a", "unknown", "--"}:
        eta = "--"
        if raw_eta is not None:
            hours, remainder = divmod(int(raw_eta), 3600)
            minutes, seconds = divmod(remainder, 60)
            eta = (
                f"{hours:02d}:{minutes:02d}:{seconds:02d}"
                if hours
                else f"{minutes:02d}:{seconds:02d}"
            )

    return min(100.0, percent) if percent is not None else 0.0, speed, eta


# OpenAI-Codex: limit the HTTP 567 workaround to BiliBili media requests.
def _bilibili_url(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").casefold().rstrip(".")
    except (TypeError, ValueError):
        return False
    return parsed.scheme in {"http", "https"} and (
        host == "bilibili.com"
        or host.endswith(".bilibili.com")
        or host == "b23.tv"
        or host.endswith(".b23.tv")
    )


def _add_bilibili_media_range(info: dict) -> None:
    if str(info.get("extractor_key", "")).casefold() != "bilibili":
        return
    formats = info.get("formats") or [info]
    for fmt in formats:
        if not isinstance(fmt, dict) or not isinstance(fmt.get("url"), str):
            continue
        try:
            parsed = urlsplit(fmt["url"])
            host = (parsed.hostname or "").casefold().rstrip(".")
        except ValueError:
            continue
        if parsed.scheme not in {"http", "https"} or not (
            host == "bilivideo.com" or host.endswith(".bilivideo.com")
        ):
            continue
        headers = fmt.get("http_headers")
        if headers is None:
            headers = {}
        if not isinstance(headers, dict) or any(
            isinstance(key, str) and key.casefold() == "range" for key in headers
        ):
            continue
        fmt["http_headers"] = {**headers, "Range": "bytes=0-"}


def _install_bilibili_range_retry(ydl: object) -> None:
    from yt_dlp.postprocessor import PostProcessor

    class BilibiliRangeRetryPP(PostProcessor):
        def run(self, info):
            _add_bilibili_media_range(info)
            return [], info

    ydl.add_post_processor(BilibiliRangeRetryPP(), when="pre_process")


class Downloader:
    """
    Stateful download orchestrator.

    The instance carries a cooperative ``_stop`` flag so a batch can be aborted
    cleanly between items. All side-effects (progress, log lines) are reported
    through the callbacks passed in at construction.

    Callbacks may be ``None``; ``Downloader`` checks before calling.
    """

    def __init__(
        self,
        options: DownloadOptions,
        log_cb: Optional[LogCallback] = None,
        progress_cb: Optional[ProgressCallback] = None,
        item_start_cb: Optional[ItemStartCallback] = None,
    ) -> None:
        self.opts = options
        self.log_cb = log_cb
        self.progress_cb = progress_cb
        self.item_start_cb = item_start_cb
        self._stop = False
        self._bilibili_range_retry = False
        self.last_summary = batch_summary(0, 0, 0, False)
        # yt-dlp expands a playlist URL into all its entries on its own (no
        # option here restricts it) -- this only tracks that expansion so we
        # can log "item i/n" as it moves between entries; it does not change
        # what gets downloaded.
        self._playlist_index_logged: Optional[int] = None

    # ── Public ──────────────────────────────────────────────────────────────
    def stop(self) -> None:
        """Request cooperative cancellation. The current item finishes first."""
        self._stop = True

    def download_one(self, url: str) -> None:
        """
        Download a single URL. Raises on failure (yt-dlp ``DownloadError`` etc.).

        This is the atomic unit reused by :meth:`download_batch` and the task
        queue; it does not catch exceptions so callers can decide how to report.
        """
        self._playlist_index_logged = None
        opts = self._build_ydl_opts(url)
        with yt_dlp.YoutubeDL(opts) as ydl:
            if self._bilibili_range_retry:
                _install_bilibili_range_retry(ydl)
            ydl.download([url])

    def preview_playlist(self, url: str) -> dict:
        """Return a bounded metadata listing without downloading media."""
        if (
            not isinstance(url, str)
            or not url.strip()
            or "\x00" in url
            or len(url) > 8192
            or any(ord(char) < 32 for char in url)
        ):
            raise ValueError("playlist URL must be a non-empty string")
        target = url.strip()
        try:
            parsed_target = urlsplit(target)
        except ValueError:
            raise ValueError("playlist URL is invalid") from None
        if parsed_target.scheme not in ("http", "https") or not parsed_target.netloc:
            raise ValueError("playlist URL must use HTTP or HTTPS")
        options = self._build_ydl_opts(target)
        for key in (
            "outtmpl",
            "format",
            "merge_output_format",
            "postprocessors",
            "progress_hooks",
            "noplaylist",
        ):
            options.pop(key, None)
        options.update(
            {
                "cachedir": False,
                # OpenAI-Codex_Fork_Source_Code: limit individual preview network waits.
                "socket_timeout": 20,
                "extractor_retries": 0,
                "extract_flat": "in_playlist",
                "ignoreerrors": True,
                "playlistend": _PLAYLIST_PREVIEW_LIMIT + 1,
                "skip_download": True,
            }
        )
        extracted = None
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(target, download=False)
                raw_entries = info.get("entries") if isinstance(info, dict) else None
                if raw_entries is not None and not isinstance(
                    raw_entries, (str, bytes, dict)
                ):
                    try:
                        # OpenAI-Codex_Fork_Source_Code: consume lazy entries before closing yt-dlp.
                        extracted = list(
                            islice(iter(raw_entries), _PLAYLIST_PREVIEW_LIMIT + 1)
                        )
                    except TypeError:
                        extracted = None
        except Exception as e:
            safe_message = redact_sensitive_urls(str(e))
            raise ValueError(
                safe_message or "playlist metadata could not be read"
            ) from None
        if not isinstance(info, dict):
            raise ValueError("playlist metadata is unavailable")
        raw_entries = info.get("entries")
        if raw_entries is None or isinstance(raw_entries, (str, bytes, dict)):
            raise ValueError("the URL did not resolve to a playlist")
        if extracted is None:
            raise ValueError("playlist entries are unavailable") from None

        shown = extracted[:_PLAYLIST_PREVIEW_LIMIT]
        entries = []
        unavailable = 0
        for ordinal, item in enumerate(shown, start=1):
            if not isinstance(item, dict):
                unavailable += 1
                continue
            entry_type = item.get("_type")
            if isinstance(entry_type, str) and entry_type.casefold() in {
                "playlist",
                "multi_video",
            }:
                unavailable += 1
                continue
            entry_extractors = (item.get("ie_key"), item.get("extractor_key"))
            if any(
                isinstance(extractor, str)
                and (
                    extractor.casefold().endswith("tab")
                    or "playlist" in extractor.casefold()
                )
                for extractor in entry_extractors
            ):
                unavailable += 1
                continue
            entry_url = self._playlist_entry_url(item)
            if not entry_url:
                unavailable += 1
                continue
            raw_index = item.get("playlist_index")
            if (
                isinstance(raw_index, int)
                and not isinstance(raw_index, bool)
                and 0 < raw_index <= (1 << 53) - 1
            ):
                index = raw_index
            elif (
                isinstance(raw_index, str)
                and len(raw_index) <= 10
                and raw_index.isascii()
                and raw_index.isdecimal()
                and int(raw_index) > 0
            ):
                index = int(raw_index)
            else:
                index = ordinal
            video_id = item.get("id")
            video_id = video_id[:256] if isinstance(video_id, str) and video_id else ""
            title = item.get("title")
            title = title.strip() if isinstance(title, str) else ""
            title = title[:500]
            raw_duration = item.get("duration")
            duration = None
            if isinstance(raw_duration, (int, float)) and not isinstance(
                raw_duration, bool
            ):
                try:
                    candidate = float(raw_duration)
                    if math.isfinite(candidate) and candidate >= 0:
                        duration = candidate
                except (OverflowError, ValueError):
                    pass
            entries.append(
                {
                    "entry_id": f"{index}:{ordinal}:{video_id}",
                    "index": index,
                    "url": entry_url,
                    "title": title or f"Item {index}",
                    "duration_seconds": duration,
                }
            )

        raw_total = info.get("playlist_count")
        if raw_total is None:
            raw_total = info.get("n_entries")
        if (
            isinstance(raw_total, bool)
            or not isinstance(raw_total, int)
            or raw_total < 0
        ):
            raw_total = len(extracted)
        raw_total = min(raw_total, (1 << 53) - 1)
        if len(extracted) <= _PLAYLIST_PREVIEW_LIMIT and raw_total > len(extracted):
            unavailable += raw_total - len(extracted)
        truncated = len(extracted) > _PLAYLIST_PREVIEW_LIMIT or (
            len(shown) >= _PLAYLIST_PREVIEW_LIMIT and raw_total > len(shown)
        )
        playlist_title = info.get("title")
        return {
            "title": (
                playlist_title.strip()[:500]
                if isinstance(playlist_title, str) and playlist_title.strip()
                else "Playlist"
            ),
            "entries": entries,
            "total_entries": max(raw_total, len(shown)),
            "unavailable_entries": unavailable,
            "truncated": truncated,
            "preview_limit": _PLAYLIST_PREVIEW_LIMIT,
        }

    @staticmethod
    def _playlist_entry_url(item: dict) -> Optional[str]:
        for key in ("webpage_url", "original_url", "url"):
            candidate = item.get(key)
            if not isinstance(candidate, str) or not candidate.strip():
                continue
            try:
                parsed = urlsplit(candidate.strip())
            except ValueError:
                continue
            if (
                len(candidate) <= 8192
                and parsed.scheme in ("http", "https")
                and parsed.netloc
                and parsed.username is None
                and parsed.password is None
            ):
                return candidate.strip()
        extractor = item.get("ie_key") or item.get("extractor_key")
        video_id = item.get("id")
        if (
            isinstance(extractor, str)
            and extractor.casefold().startswith("youtube")
            and isinstance(video_id, str)
            and video_id
            and len(video_id) <= 256
        ):
            return "https://www.youtube.com/watch?v=" + quote(video_id, safe="")
        return None

    def download_batch(self, urls: Iterable[str]) -> list[tuple[str, bool, str]]:
        """
        Download every URL sequentially.

        Returns a list of ``(url, success, error_message)`` triples.
        """
        # OpenAI-Codex: preserve a stop requested before entry; consume it after reporting.
        try:
            return self._run_batch(urls)
        finally:
            self._stop = False

    def _check_destination_space(self) -> None:
        try:
            free_bytes = shutil.disk_usage(self.opts.save_path).free
        except OSError as exc:
            self._log("warn", "log_disk_check_failed", err=str(exc))
            return
        if free_bytes < 100 * 1024 * 1024:
            raise ValueError("Less than 100 MiB available at the download destination")

    def _run_batch(self, urls: Iterable[str]) -> list[tuple[str, bool, str]]:
        urls = list(urls)
        total = len(urls)
        results: list[tuple[str, bool, str]] = []

        if urls and not self._stop:
            self._check_destination_space()

        self._log("info", "log_start_batch", n=total)

        for i, url in enumerate(urls, start=1):
            if self._stop:
                self._log("warn", "log_stopped_dl")
                break

            if self.item_start_cb:
                self.item_start_cb(i, total, url)
            self._log("info", "log_item_downloading", i=i, t=total, url=url)

            try:
                self._download_one_with_retry(url, i, total)
                self._log("ok", "log_item_done", i=i, t=total)
                results.append((url, True, ""))
            except OperationCancelled:
                # OpenAI-Codex_engine_cli: explicit cancellation stops the batch.
                self._stop = True
                self._log("warn", "log_stopped_dl")
                break
            except Exception as e:  # yt-dlp raises DownloadError + others
                message = redact_sensitive_urls(str(e))
                self._log("err", "log_item_error", i=i, t=total, err=message)
                # OpenAI-Codex: provide targeted guidance without reading cookies.
                lowered = message.lower()
                if "could not copy chrome cookie database" in lowered:
                    self._log("warn", "log_hint_cookie_database")
                elif _bilibili_url(url) and "http error 412" in lowered:
                    # OpenAI-Codex_site_error: keep the original failure and explain the site response.
                    self._log("warn", "log_hint_bilibili_412")
                elif "http error 567" in lowered:
                    self._log("warn", "log_hint_http_567")
                elif "bytes read" in lowered and "more expected" in lowered:
                    self._log("warn", "log_hint_incomplete_download")
                results.append((url, False, message))

        succeeded = sum(1 for _, success, _ in results if success)
        self.last_summary = batch_summary(
            total, succeeded, len(results) - succeeded, self._stop
        )
        self._log_batch_summary(results, total)
        return results

    def _log_batch_summary(
        self, results: list[tuple[str, bool, str]], total: int
    ) -> None:
        """
        Report how the batch actually ended.

        Previously this always logged ``log_all_done`` at "ok" level, so a batch
        where every item failed still showed a green checkmark. Mirrors the
        ok/fail reporting :class:`engine.queue.TaskQueue` already does.
        """
        # OpenAI-Codex_engine_cli: avoid complete-batch logs for partial results.
        if len(results) != total:
            return

        ok = sum(1 for _, success, _ in results if success)
        fail = len(results) - ok

        if fail == 0 and not self._stop and len(results) == total:
            self._log("ok", "log_all_done", t=total)
        elif fail and ok == 0:
            self._log("err", "log_all_failed", t=fail)
        elif fail:
            self._log("warn", "log_all_done_partial", ok=ok, fail=fail, t=total)

    def download_one_with_retry(self, url: str, index: int = 1, total: int = 1) -> None:
        """Apply the same retry policy to a single queue item and a normal batch."""
        self._check_destination_space()
        self._download_one_with_retry(url, index, total)

    def _download_one_with_retry(self, url: str, i: int, total: int) -> None:
        """Retry ``download_one`` on transient errors (e.g. YouTube 403s)."""
        self._bilibili_range_retry = False
        try:
            self._download_one_with_retry_impl(url, i, total)
        finally:
            self._bilibili_range_retry = False

    def _download_one_with_retry_impl(self, url: str, i: int, total: int) -> None:
        # OpenAI-Codex_app_ui: retain the last failed attempt during retry.
        last_error: Exception | None = None
        for attempt in range(_MAX_RETRIES + 1):
            if self._stop:
                if last_error is not None:
                    raise last_error
                raise OperationCancelled("download stopped")
            try:
                self.download_one(url)
                return
            except Exception as e:
                # OpenAI-Codex_app_ui: preserve cancellation and in-flight errors.
                if isinstance(e, OperationCancelled) or self._stop:
                    raise
                is_transient = classify(e) is ErrorKind.TRANSIENT
                if attempt < _MAX_RETRIES and self._stop:
                    raise
                if not is_transient or attempt == _MAX_RETRIES:
                    # A 403 that survives every retry is almost always a stale
                    # extractor (YouTube rotates its player), not a transient
                    # blip -- point the user at updating rather than retrying.
                    # That is the TRANSIENT -> STALE_TOOL transition: the same
                    # exception means something different once retrying failed.
                    # OpenAI-Codex_engine_cli: stop before exhaustion is not repeated 403.
                    if self._stop and attempt < _MAX_RETRIES:
                        raise
                    if is_stale_tool(e):
                        self._log("warn", "log_hint_outdated", i=i, t=total)
                    raise
                if _bilibili_url(url) and "http error 567" in str(e).casefold():
                    self._bilibili_range_retry = True
                # Log before sleeping: otherwise the UI sits silent for the
                # whole delay and looks frozen.
                self._log(
                    "info",
                    "log_item_retry",
                    i=i,
                    t=total,
                    n=attempt + 1,
                    max=_MAX_RETRIES,
                )
                last_error = e
                if self._stop:
                    raise
                time.sleep(_RETRY_DELAY_S)

    # ── Private ─────────────────────────────────────────────────────────────
    def _build_ydl_opts(self, url: str) -> dict:
        o = self.opts
        headers = platform_headers(url)

        base: dict = {
            "outtmpl": os.path.join(o.save_path, "%(title)s.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [self._ydl_hook],
            # OpenAI-Codex: keep partial data resumable and stdout available for sidecar events.
            "noprogress": True,
            "continuedl": True,
            "nopart": False,
            "concurrent_fragment_downloads": 4,
            "fragment_retries": 10,  # 分段下載失敗重試次數
            "retries": 10,  # 總網路重試次數
            # Let yt-dlp adapt the buffer and use the extractor's HTTP chunk policy.
        }
        if type(o.noplaylist) is not bool:
            raise ValueError("noplaylist must be a boolean")
        if o.noplaylist:
            base["noplaylist"] = True

        # Cookies: file first (more reliable), then browser.
        if o.cookie_file:
            if not os.path.isfile(o.cookie_file):
                raise ValueError("Cookie file does not exist or is not a regular file")
            base["cookiefile"] = o.cookie_file
            self._log("info", "log_cookie_file", name=os.path.basename(o.cookie_file))
        elif o.browser and o.browser != "none":
            base["cookiesfrombrowser"] = (o.browser, None, None, None)
            self._log("info", "log_cookie_browser", browser=o.browser)

        if headers:
            base["http_headers"] = headers

        # Validated here, in the branch that consumes them, because this is
        # where they are composed into the output template and the format
        # selector -- the same reason Converter.make_job() validates dst_fmt.
        # Only the fields this mode actually uses are checked, so a caller that
        # leaves the other mode's field blank is not punished for it.
        if o.mode == "video":
            fmt = ensure_known(o.video_fmt, VIDEO_FORMATS, "video format")
            quality = ensure_known(o.quality, QUALITY_PRESETS, "quality preset")
            return {
                **base,
                "format": build_ydl_format_string(quality, fmt),
                "merge_output_format": fmt,
            }

        # audio mode
        bitrate = o.bitrate.strip() if isinstance(o.bitrate, str) else ""
        digits = bitrate.lstrip("0") or "0"
        if (
            not bitrate.isascii()
            or not bitrate.isdecimal()
            or len(digits) > 4
            or not 1 <= int(digits) <= 9999
        ):
            raise ValueError("bitrate must be a decimal string between 1 and 9999 kbps")
        return {
            **base,
            "format": "bestaudio/best",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": ensure_known(
                        o.audio_fmt, AUDIO_FORMATS, "audio format"
                    ),
                    "preferredquality": str(int(digits)),
                }
            ],
        }

    def _ydl_hook(self, d: dict) -> None:
        """yt-dlp progress hook — fans out to the registered progress callback."""
        # OpenAI-Codex: cancel an active transfer at the next progress callback.
        if self._stop and d.get("status") == "downloading":
            raise OperationCancelled("download stopped")
        info = d.get("info_dict") or {}
        n_entries, idx = info.get("n_entries"), info.get("playlist_index")
        if n_entries and idx and idx != self._playlist_index_logged:
            self._playlist_index_logged = idx
            self._log(
                "info",
                "log_playlist_item",
                i=idx,
                t=n_entries,
                title=info.get("title") or info.get("id") or "",
            )

        if d["status"] == "downloading" and self.progress_cb:
            try:
                self.progress_cb(*_download_progress(d))
            except (ValueError, TypeError):
                pass
        elif d["status"] == "finished" and self.progress_cb:
            self.progress_cb(100.0, "--", "--")

    # ── Log dispatch ────────────────────────────────────────────────────────
    def _log(self, level: str, key: str, **fmt) -> None:
        if self.log_cb:
            safe = {
                name: redact_sensitive_urls(value) if isinstance(value, str) else value
                for name, value in fmt.items()
            }
            self.log_cb(level, key, **safe)
