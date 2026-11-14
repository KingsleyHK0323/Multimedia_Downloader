# OpenAI-Codex_engine_cli
"""Redact sensitive URL components in log text before export or display."""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

_HTTP_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_TRAILING_PUNCTUATION = ".,;:!)}"


def redact_sensitive_urls(text: str) -> str:
    """Hide HTTP(S) userinfo, query and fragment values in arbitrary text.

    This deliberately leaves the URL path available for diagnostics. Secrets
    embedded in a path or outside an HTTP(S) URL require separate handling.
    """
    def redact(match: re.Match) -> str:
        raw = match.group(0)
        url = raw.rstrip(_TRAILING_PUNCTUATION)
        trailing = raw[len(url):]
        try:
            parts = urlsplit(url)
            if not parts.netloc:
                return "[redacted URL]" + trailing
            authority = parts.netloc
            if "@" in authority:
                authority = "[redacted]@" + authority.rsplit("@", 1)[1]
            result = urlunsplit((
                parts.scheme,
                authority,
                parts.path,
                "[redacted]" if parts.query else "",
                "[redacted]" if parts.fragment else "",
            ))
            return result + trailing
        except ValueError:
            return "[redacted URL]" + trailing

    return _HTTP_URL.sub(redact, text)
