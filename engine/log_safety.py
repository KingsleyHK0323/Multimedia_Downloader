# OpenAI-Codex_engine_cli
"""Redact sensitive URL components in log text before export or display."""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

_HTTP_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_TRAILING_PUNCTUATION = ".,;:!)}"

# OpenAI-Codex_web_ai: keep apostrophes within URLs while separating quoted URLs.
_HTTP_URL = re.compile(
    r"""https?://(?:(?!'\s*[,;]\s*'?https?://)[^\s<>"])+""",
    re.IGNORECASE,
)

# OpenAI-Codex_web_ai: keep ambiguous nested URLs inside a sensitive component.
_HTTP_URL = re.compile(
    r"""https?://(?:(?=(?:(?!https?://)[^\s<>"])*[?#])[^\s<>"]+|(?:(?!https?://)[^\s<>"])+)""",
    re.IGNORECASE,
)

# OpenAI-Codex_app_ui: redact common credential headers and named values in diagnostics.
_SENSITIVE_HEADER = re.compile(
    r"""(^|[^A-Za-z0-9_-])(["']?(?:proxy-authorization|authorization|set-cookie|cookie)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)""",
    re.IGNORECASE | re.MULTILINE,
)
_BEARER = re.compile(r"\bBearer\s+[^\s,;]+", re.IGNORECASE)
_SENSITIVE_PAIR = re.compile(
    r"""(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)""",
    re.IGNORECASE,
)


def redact_sensitive_urls(text: str) -> str:
    """Hide HTTP(S) userinfo, query and fragment values in arbitrary text.

    This deliberately leaves the URL path available for diagnostics. Secrets
    embedded in a path or outside an HTTP(S) URL require separate handling.
    """

    def redact(match: re.Match) -> str:
        raw = match.group(0)
        url = raw.rstrip(_TRAILING_PUNCTUATION)
        trailing = raw[len(url) :]
        # OpenAI-Codex_web_ai: preserve a matching single-quote wrapper.
        if (
            url.endswith("'")
            and match.start()
            and match.string[match.start() - 1] == "'"
        ):
            url = url[:-1]
            trailing = "'" + trailing
        try:
            # OpenAI-Codex_web_ai: parse the previous redaction marker as userinfo.
            url = re.sub(
                r"^(https?://)\[redacted\]@", r"\1redacted@", url, flags=re.IGNORECASE
            )
            parts = urlsplit(url)
            if not parts.netloc:
                return "[redacted URL]" + trailing
            authority = parts.netloc
            if "@" in authority:
                authority = "[redacted]@" + authority.rsplit("@", 1)[1]
            result = urlunsplit(
                (
                    parts.scheme,
                    authority,
                    parts.path,
                    "[redacted]" if parts.query else "",
                    "[redacted]" if parts.fragment else "",
                )
            )
            return result + trailing
        except ValueError:
            return "[redacted URL]" + trailing

    # OpenAI-Codex_engine_cli: cover ambiguous raw quotes before URL parsing.
    def redact_ambiguous_quote(match: re.Match) -> str:
        raw = match.group(0)
        if '"' not in raw or not any(marker in raw for marker in "@?#"):
            return raw
        if (
            match.start()
            and match.string[match.start() - 1] == '"'
            and raw.count('"') == 1
            and re.search(r'"[.,;:!)}]*$', raw)
        ):
            return raw
        return "[redacted URL]"

    text = re.sub(
        r"https?://[^\s<>]+", redact_ambiguous_quote, text, flags=re.IGNORECASE
    )

    # OpenAI-Codex_web_ai: protect complete URLs before header substitutions.
    text = _HTTP_URL.sub(redact, text)
    text = _SENSITIVE_HEADER.sub(r'\1\2"[redacted]"', text)
    text = _BEARER.sub("Bearer [redacted]", text)
    text = _SENSITIVE_PAIR.sub(r"\1[redacted]", text)
    return _HTTP_URL.sub(redact, text)
