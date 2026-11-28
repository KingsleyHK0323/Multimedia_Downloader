"""
Multi-model orchestration for the AI assistant.

Flow (see Obsidian `System_Architecture/V4.0 System Architecture.md` §4):

    user request
        -> PLANNER    drafts a batch plan (what files, what params)
        -> EXECUTOR   turns the plan into concrete, schema-valid tasks
        -> guard      deterministic safety/shape check (defense in depth)
        -> CHECKER    reviews the final tasks against the request, advisory
        -> (show plan to user, AWAIT CONFIRM)          <-- D4 permission gate
        -> engine executes the confirmed tasks (via engine.queue.TaskQueue)
        -> SUMMARIZER condenses the results afterwards

``Orchestrator.plan()`` NEVER touches the filesystem, downloads anything, or
runs ffmpeg — it only talks to OpenRouter and returns a plan for the caller to
show the user. Execution happens separately, only after explicit confirmation.

The user's OpenRouter API key is supplied by the caller at request time; this
module does not persist it. The caller is responsible for secure key storage.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from typing import Callable, Optional

from engine.formats import AUDIO_FORMATS, BROWSERS, QUALITY_PRESETS, VIDEO_FORMATS
from engine.options import LogCallback

from .models import (
    CHECKER,
    EXECUTOR,
    OPENROUTER_BASE_URL,
    PLANNER,
    SUMMARIZER,
    CatalogFetch,
    Model,
    Roster,
    resolve_roster,
)

#: Substrings marking "this model id isn't servable" as opposed to a real
#: request/auth failure. The catalogue can lag reality by minutes, so a slug it
#: listed may still 404 at call time — that is worth one retry on an alternate,
#: whereas a 401 or a rate limit is not.
_DEAD_MODEL_MARKERS = (
    "HTTP 404",
    "HTTP 400",
    "not a valid model",
    "No endpoints found",
    "No allowed providers",
)


class OrchestratorError(RuntimeError):
    """Raised for any failure talking to OpenRouter or parsing its replies."""


# OpenAI-Codex_web_ai: do not pass control characters into HTTP headers.
def _reject_key_controls(api_key: str) -> None:
    if isinstance(api_key, str) and any(
        ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in api_key
    ):
        raise OrchestratorError("OpenRouter API key contains control characters")


#: ``(url, payload, api_key) -> parsed_json_response`` — injectable for tests.
Transport = Callable[[str, dict, str], dict]


def _default_transport(url: str, payload: dict, api_key: str) -> dict:
    req = urllib.request.Request(  # noqa: S310  (see justification below)
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        # noqa justification: the URL is built from OPENROUTER_BASE_URL,
        # a module constant pinned to https -- never from user input, so
        # the file:/custom-scheme risk this rule guards against cannot arise.
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # OpenAI-Codex_web_ai: bound provider reads and expose only fixed retry markers.
        marker = ""
        try:
            prefix = bytearray()
            while len(prefix) < 1200:
                chunk = e.read(1200 - len(prefix))
                if not chunk:
                    break
                prefix.extend(chunk[: 1200 - len(prefix)])
            preview = prefix.decode("utf-8", "replace")[:300]
            marker = next((item for item in _DEAD_MODEL_MARKERS if item in preview), "")
        except Exception:  # noqa: S110 - Do not expose response read errors.
            pass  # noqa: S110
        finally:
            try:
                e.close()
            except Exception:  # noqa: S110 - Keep close failures out of diagnostics.
                pass  # noqa: S110
        status = (
            int(e.code)
            if isinstance(e.code, int) and 100 <= e.code <= 999
            else "unknown"
        )
        raise OrchestratorError(f"OpenRouter HTTP {status}: {marker}") from None
        body = e.read().decode("utf-8", "replace")
        raise OrchestratorError(f"OpenRouter HTTP {e.code}: {body[:300]}") from e
    except urllib.error.URLError as e:
        # OpenAI-Codex_web_ai: preserve only fixed fallback markers, not the reason.
        try:
            reason = f"{e.reason}"
            marker = next((item for item in _DEAD_MODEL_MARKERS if item in reason), "")
        except Exception:
            marker = ""
        raise OrchestratorError(f"OpenRouter request failed: {marker}") from None
        raise OrchestratorError(f"OpenRouter request failed: {e.reason}") from e
    except TimeoutError:
        # OpenAI-Codex_web_ai: do not expose timeout details or the exception chain.
        raise OrchestratorError("OpenRouter request timed out") from None


# OpenAI-Codex_web_ai: bound unexpected default-transport errors at the outer edge.
_unchecked_default_transport = _default_transport


def _safe_default_transport(url: str, payload: dict, api_key: str) -> dict:
    _reject_key_controls(api_key)
    try:
        return _unchecked_default_transport(url, payload, api_key)
    except OrchestratorError:
        raise
    except Exception:
        # This hides internal diagnostics; the original remains in exception context.
        raise OrchestratorError("OpenRouter request failed unexpectedly") from None


_default_transport = _safe_default_transport


# OpenAI-Codex_web_ai: reject duplicate keys rather than silently overwriting them.
def _unique_json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise OrchestratorError("model reply contains duplicate JSON keys")
        result[key] = value
    return result


# OpenAI-Codex_web_ai: JSON constants must not contain non-finite values.
def _reject_json_constant(_constant):
    raise OrchestratorError("model reply contains a nonstandard JSON constant")


# OpenAI-Codex_web_ai: reject JSON numbers that overflow Python floats.
def _finite_json_float(number):
    value = float(number)
    if not math.isfinite(value):
        raise OrchestratorError("model reply contains a non-finite JSON number")
    return value


def _extract_json(text: str) -> dict:
    """Decode the first top-level object without counting braces in strings."""
    # OpenAI-Codex_web_ai: JSONDecoder handles quoted and escaped characters.
    if not isinstance(text, str):
        raise OrchestratorError("model reply was not text")
    start = text.find("{")
    if start == -1:
        raise OrchestratorError("model reply had no JSON object")
    # OpenAI-Codex_web_ai: avoid extracting an object from a surrounding array or string.
    array_depth = 0
    in_string = False
    escaped = False
    for character in text[:start]:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
        elif character == '"':
            in_string = True
        elif character == "[":
            array_depth += 1
        elif character == "]":
            if array_depth == 0:
                raise OrchestratorError("model reply has ambiguous prefix framing")
            array_depth -= 1
    if in_string or array_depth:
        raise OrchestratorError("model reply has ambiguous prefix framing")
    try:
        obj, _ = json.JSONDecoder().raw_decode(text, start)
        json.JSONDecoder(object_pairs_hook=_unique_json_pairs).raw_decode(text, start)
        json.JSONDecoder(parse_constant=_reject_json_constant).raw_decode(text, start)
        json.JSONDecoder(parse_float=_finite_json_float).raw_decode(text, start)
        if "{" in text[_:] or "}" in text[_:]:
            raise OrchestratorError("model reply has ambiguous trailing object content")
        # OpenAI-Codex_web_ai: reject unmatched closing brackets after the JSON object.
        suffix = text[_:]
        suffix_depth = 0
        suffix_in_string = False
        suffix_escaped = False
        quote_start = 0
        for index, character in enumerate(suffix):
            if suffix_in_string:
                if suffix_escaped:
                    suffix_escaped = False
                elif character == "\\":
                    suffix_escaped = True
                elif character == '"':
                    suffix_in_string = False
            elif character == '"':
                suffix_in_string = True
                quote_start = index
            elif character == "[":
                suffix_depth += 1
            elif character == "]":
                if suffix_depth == 0:
                    raise OrchestratorError(
                        "model reply has ambiguous trailing array framing"
                    )
                suffix_depth -= 1
        if suffix_in_string and "]" in suffix[quote_start:]:
            raise OrchestratorError("model reply has ambiguous trailing array framing")
    except json.JSONDecodeError as e:
        raise OrchestratorError(f"model reply had invalid JSON: {e}") from e
    return obj


_TASK_SCHEMA_HINT = """Return ONLY a JSON object (no prose, no markdown fences) shaped like:
{
  "summary": "one short sentence describing the plan",
  "tasks": [
    {"kind": "download", "label": "...", "url": "...",
     "options": {"save_path": "...", "mode": "video", "video_fmt": "mp4",
                 "audio_fmt": "mp3", "quality": "best", "bitrate": "192", "browser": "none"}},
    {"kind": "convert", "label": "...", "src_path": "...", "dst_path": "...",
     "conflict_policy": "rename"}
  ]
}
Every task is either kind "download" (needs url + options) or kind "convert"
(needs src_path + dst_path). Only use values from the known lists below."""


def _validate_tasks(raw_tasks) -> tuple[list[dict], list[str]]:
    """
    Deterministic safety/shape guard — defense in depth under the LLM checker.

    Drops malformed tasks (recording a warning) and clamps any format/quality/
    browser value that isn't in the known catalogue to a safe default, rather
    than trusting the model's output verbatim.
    """
    warnings: list[str] = []
    clean: list[dict] = []
    for i, t in enumerate(raw_tasks if isinstance(raw_tasks, list) else []):
        if not isinstance(t, dict):
            warnings.append(f"task {i + 1}: skipped (not an object)")
            continue
        kind = t.get("kind")
        label = str(t.get("label") or f"task {i + 1}")

        if kind == "download":
            url = t.get("url")
            options = t.get("options") if isinstance(t.get("options"), dict) else {}
            if not isinstance(url, str) or not url.strip():
                warnings.append(f"{label}: skipped (missing url)")
                continue
            save_path = options.get("save_path")
            if not isinstance(save_path, str) or not save_path.strip():
                warnings.append(f"{label}: skipped (missing save_path)")
                continue

            def choice(field, allowed, default):
                if field not in options:
                    return default
                value = options[field]
                if isinstance(value, str) and value in allowed:
                    return value
                warnings.append(f"{label}: invalid {field}; using {default}")
                return default

            mode = choice("mode", ("video", "audio"), "video")
            video_fmt = choice("video_fmt", VIDEO_FORMATS, "mp4")
            audio_fmt = choice("audio_fmt", AUDIO_FORMATS, "mp3")
            quality = choice("quality", QUALITY_PRESETS, "best")
            browser = choice("browser", BROWSERS, "none")
            bitrate = options.get("bitrate", "192")
            if isinstance(bitrate, str):
                bitrate = bitrate.strip()
            digits = (bitrate.lstrip("0") or "0") if isinstance(bitrate, str) else ""
            if (
                not isinstance(bitrate, str)
                or not bitrate.isascii()
                or not bitrate.isdecimal()
                or len(digits) > 4
                or not 1 <= int(digits) <= 9999
            ):
                warnings.append(f"{label}: invalid bitrate; using 192")
                bitrate = "192"
            else:
                bitrate = str(int(digits))
            clean.append(
                {
                    "kind": "download",
                    "label": label,
                    "url": url,
                    "options": {
                        "save_path": save_path,
                        "mode": mode,
                        "video_fmt": video_fmt,
                        "audio_fmt": audio_fmt,
                        "quality": quality,
                        "bitrate": bitrate,
                        "browser": browser,
                    },
                }
            )

        elif kind == "convert":
            src = t.get("src_path")
            dst = t.get("dst_path")
            if (
                not isinstance(src, str)
                or not src.strip()
                or not isinstance(dst, str)
                or not dst.strip()
            ):
                warnings.append(f"{label}: skipped (missing src_path/dst_path)")
                continue
            policy = t.get("conflict_policy", "rename")
            if policy == "overwrite":
                warnings.append(
                    f"{label}: overwrite requires explicit confirmation; using rename"
                )
                policy = "rename"
            elif policy not in ("rename", "skip"):
                warnings.append(f"{label}: invalid conflict_policy; using rename")
                policy = "rename"
            clean.append(
                {
                    "kind": "convert",
                    "label": label,
                    "src_path": src,
                    "dst_path": dst,
                    "conflict_policy": policy,
                }
            )

        else:
            warnings.append(f"{label}: skipped (unknown task kind {kind!r})")

    # OpenAI-Codex_web_ai: do not infer dependencies from task order or paths.
    seen_download = False
    for task in clean:
        if task["kind"] == "download":
            seen_download = True
        elif task["kind"] == "convert" and seen_download:
            warnings.append(
                "Download outputs are not tracked. A later conversion may read an existing file "
                "even if an earlier download fails; check each conversion source separately."
            )
            break
    return clean, warnings


class Orchestrator:
    """Coordinates the four free OpenRouter models (see :mod:`ai.models`)."""

    def __init__(
        self,
        api_key: str,
        transport: Transport = _default_transport,
        log_cb: Optional[LogCallback] = None,
        catalog_fetch: Optional[CatalogFetch] = None,
    ) -> None:
        _reject_key_controls(api_key)
        if not api_key or not api_key.strip():
            raise OrchestratorError("missing OpenRouter API key")
        self._api_key = api_key
        self._transport = transport
        self._log = log_cb or (lambda *a, **k: None)
        self._catalog_fetch = catalog_fetch
        self._roster: Optional[Roster] = None

    # ── Roster ────────────────────────────────────────────────────────────────
    def roster(self) -> Roster:
        """
        The models to call, resolved against the live catalogue on first use.

        Resolved lazily rather than at app startup: the assistant is optional
        (it needs the user's own API key), so an unused feature must not cost
        every launch a network round-trip. :func:`~ai.models.resolve_roster`
        caches across instances, so one lookup covers a whole session.
        """
        if self._roster is None:
            self._roster = resolve_roster(fetch=self._catalog_fetch)
            for note in self._roster.notes:
                if self._roster.verified:
                    self._log("info", "log_ai_model_swapped", note=note)
                else:
                    self._log("warn", "log_ai_roster_unverified", err=note)
        return self._roster

    def _model(self, preferred: Model) -> Model:
        """Resolve a role's preferred model to whatever is actually live."""
        return self.roster().models.get(preferred.role, preferred)

    def _post(self, model: Model, system: str, user: str) -> str:
        payload = {
            "model": model.slug,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
        }
        resp = self._transport(
            f"{OPENROUTER_BASE_URL}/chat/completions", payload, self._api_key
        )
        try:
            content = resp["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            # OpenAI-Codex_engine_cli: suppress custom response details in formatted tracebacks.
            raise OrchestratorError(
                f"unexpected response shape from {model.slug}"
            ) from None
            raise OrchestratorError(
                f"unexpected response shape from {model.slug}"
            ) from e
        if not isinstance(content, str):
            raise OrchestratorError(f"non-text response from {model.slug}")
        return content

    def _call(self, preferred: Model, system: str, user: str) -> str:
        """
        Call a role's model, falling back once per alternate if the slug turns
        out to be dead despite the catalogue listing it.
        """
        model = self._model(preferred)
        tried: set[str] = set()
        while True:
            tried.add(model.slug)
            try:
                return self._post(model, system, user)
            except OrchestratorError as e:
                if not any(m in str(e) for m in _DEAD_MODEL_MARKERS):
                    raise  # a real failure (auth, rate limit, network) — surface it
                alt = self.roster().next_alternate(preferred.role, tried)
                if alt is None:
                    raise
                self._log(
                    "info",
                    "log_ai_model_swapped",
                    note=f"{preferred.role}: {model.slug} rejected the request — "
                    f"retrying with {alt.slug}",
                )
                model = alt

    def _catalogue(self, context: dict) -> str:
        return (
            f"Known video formats: {VIDEO_FORMATS}\n"
            f"Known audio formats: {AUDIO_FORMATS}\n"
            f"Known quality presets: {QUALITY_PRESETS}\n"
            f"Known browsers: {BROWSERS}\n"
            "Audio bitrate: a decimal string from 1 to 9999 kbps; default '192'.\n"
            "Convert conflict_policy: 'rename' or 'skip'; overwrite requires separate confirmation.\n"
            f"Default save_path if the user didn't specify one: {context.get('save_path', '')!r}\n"
            f"Default browser if the user didn't specify one: {context.get('browser', 'none')!r}\n"
        )

    def plan(self, user_request: str, context: Optional[dict] = None) -> dict:
        """
        Return a proposed batch plan for user confirmation. Never executes
        anything — the caller is responsible for the D4 confirm gate and for
        actually running the returned tasks (e.g. via ``engine.queue.TaskQueue``).
        """
        context = context or {}
        catalogue = self._catalogue(context)

        self._log("info", "log_ai_planning_start")
        # Resolve before the first call so a dead slug is substituted rather
        # than 404-ing the whole pipeline (the V4.0 failure mode).
        roster_notes = list(self.roster().notes)
        draft_raw = self._call(
            PLANNER,
            "You are a planning assistant for a media downloader/converter app. "
            "Given a user's request, draft a batch plan of download/convert tasks.\n"
            + catalogue
            + "\n"
            + _TASK_SCHEMA_HINT,
            user_request,
        )
        draft = _extract_json(draft_raw)
        # OpenAI-Codex_web_ai: reject provider errors and malformed task lists.
        if "error" in draft:
            raise OrchestratorError("AI planner reported an error")
        if not isinstance(draft.get("tasks"), list):
            raise OrchestratorError(
                "AI planner returned a missing or invalid task list"
            )

        self._log("info", "log_ai_executing")
        exec_raw = self._call(
            EXECUTOR,
            "You refine a draft task plan into strictly valid tasks. Fix any format/"
            "quality/browser value that is not in the known lists (use the closest "
            "valid one, or 'best'/'none'). Keep the same tasks and intent.\n"
            + catalogue
            + "\n"
            + _TASK_SCHEMA_HINT,
            json.dumps(draft),
        )
        refined = _extract_json(exec_raw)
        if "error" in refined:
            raise OrchestratorError("AI executor reported an error")
        if not isinstance(refined.get("tasks"), list):
            raise OrchestratorError(
                "AI executor returned a missing or invalid task list"
            )
        # OpenAI-Codex_web_ai: an executor cannot invent tasks for an empty draft.
        if not draft["tasks"] and refined["tasks"]:
            raise OrchestratorError(
                "AI executor returned tasks for an empty planner draft"
            )

        tasks, warnings = _validate_tasks(refined.get("tasks", []))
        # The AI panel already renders `warnings`, so surfacing substitutions
        # here tells the user which models actually ran without any UI change.
        warnings = roster_notes + warnings

        self._log("info", "log_ai_checking")
        if tasks:
            try:
                check_raw = self._call(
                    CHECKER,
                    "You review a finalized task plan for a media downloader/converter "
                    "app against the user's original request. Reply with ONLY a JSON "
                    'object: {"ok": true|false, "warnings": ["..."]}. Flag anything that '
                    "looks like it does not match the request, or touches unexpected files.",
                    f"User request: {user_request}\nFinal tasks: {json.dumps(tasks)}",
                )
                verdict = _extract_json(check_raw)
                if "error" in verdict:
                    raise OrchestratorError("AI checker reported an error")
                if verdict.get("ok") is False:
                    warnings.append("AI checker reported that the plan needs review")
                elif verdict.get("ok") is not True:
                    warnings.append("AI checker did not return a valid verdict")
                checker_warnings = verdict.get("warnings", [])
                if isinstance(checker_warnings, list):
                    warnings.extend(str(w) for w in checker_warnings)
                else:
                    warnings.append("AI checker returned invalid warnings")
            except Exception:
                # The checker is advisory. Do not expose provider response data.
                warnings.append(
                    "AI checker could not review this plan; inspect every task"
                )

        self._log("ok", "log_ai_plan_ready", n=len(tasks))
        return {
            "summary": refined.get("summary") or draft.get("summary") or user_request,
            "tasks": tasks,
            "warnings": warnings,
        }

    def summarize(self, results: list[dict]) -> str:
        """Ask SUMMARIZER for a short, human-readable recap of a finished run."""
        text = self._call(
            SUMMARIZER,
            "Summarize this batch run for the user in ONE short plain-text sentence "
            "(no JSON, no markdown).",
            json.dumps(results),
        )
        return text.strip()
