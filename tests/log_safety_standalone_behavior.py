"""Check common diagnostic redactions with invented values and no network.

OpenAI-Codex_engine_cli: unknown formats and URL paths remain outside the
redaction guarantee; this test does not use real credentials or media.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "engine" / "log_safety.py"
SPEC = importlib.util.spec_from_file_location("synthetic_log_safety", SOURCE)
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
redact = module.redact_sensitive_urls


# OpenAI-Codex_web_ai: protect apostrophes inside HTTP(S) URL components.
def _check_apostrophe_urls():
    cases = (
        (
            "userinfo apostrophe",
            "https://FAKE_USER'FAKE_PART:FAKE_PASS@example.invalid/watch",
            "https://[redacted]@example.invalid/watch",
        ),
        (
            "leading userinfo apostrophe",
            "https://'FAKE_USER:FAKE_PASS@example.invalid/watch",
            "https://[redacted]@example.invalid/watch",
        ),
        (
            "query apostrophe",
            "https://example.invalid/watch?token=FAKE_HEAD'FAKE_TAIL",
            "https://example.invalid/watch?[redacted]",
        ),
        (
            "fragment apostrophe",
            "https://example.invalid/watch#FAKE_HEAD'FAKE_TAIL",
            "https://example.invalid/watch#[redacted]",
        ),
        (
            "consecutive apostrophes",
            "https://FAKE_USER''FAKE_PART:FAKE_PASS@example.invalid/watch?token=FAKE_A''FAKE_B",
            "https://[redacted]@example.invalid/watch?[redacted]",
        ),
        (
            "single-quoted URL",
            "Fetch 'https://FAKE_USER'FAKE_PART:FAKE_PASS@example.invalid/watch?x=FAKE_A'FAKE_B#FAKE_C'FAKE_D' done.",
            "Fetch 'https://[redacted]@example.invalid/watch?[redacted]#[redacted]' done.",
        ),
        (
            "double-quoted URL",
            'Fetch "https://example.invalid/watch?x=FAKE_A\'FAKE_B" done.',
            'Fetch "https://example.invalid/watch?[redacted]" done.',
        ),
        (
            "adjacent quoted URLs",
            "Links 'https://example.invalid/a?x=FAKE_A','https://FAKE_USER:FAKE_PASS@example.test/b?x=FAKE_B'.",
            "Links 'https://example.invalid/a?[redacted]','https://[redacted]@example.test/b?[redacted]'.",
        ),
        # OpenAI-Codex_web_ai: cover trailing quotes and a nested query URL.
        (
            "trailing query apostrophe",
            "https://example.invalid/watch?token=FAKE_QUERY'",
            "https://example.invalid/watch?[redacted]",
        ),
        (
            "trailing fragment apostrophe",
            "https://example.invalid/watch#FAKE_FRAGMENT'",
            "https://example.invalid/watch#[redacted]",
        ),
        (
            "wrapped trailing value apostrophe",
            "See 'https://example.invalid/watch?token=FAKE_QUERY''.",
            "See 'https://example.invalid/watch?[redacted]'.",
        ),
        (
            "nested URL in query",
            "https://example.invalid/watch?next=https://example.test/FAKE_QUERY",
            "https://example.invalid/watch?[redacted]",
        ),
        # OpenAI-Codex_web_ai: treat ambiguous adjacent text as one sensitive query.
        (
            "ambiguous nested query",
            "https://example.invalid/watch?next=FAKE_HEAD','https://example.test/FAKE_SECRET",
            "https://example.invalid/watch?[redacted]",
        ),
        (
            "adjacent URLs without first query",
            "Links 'https://example.invalid/a','https://FAKE_USER:FAKE_PASS@example.test/b?x=FAKE_QUERY'.",
            "Links 'https://example.invalid/a','https://[redacted]@example.test/b?[redacted]'.",
        ),
        # OpenAI-Codex_web_ai: a header-like URL field must not split its own URL.
        (
            "authorization userinfo",
            "https://Authorization='FAKE_USER'FAKE_TAIL@example.invalid/watch",
            "https://[redacted]@example.invalid/watch",
        ),
        (
            "cookie userinfo",
            "https://Cookie='FAKE_USER'FAKE_TAIL@example.invalid/watch",
            "https://[redacted]@example.invalid/watch",
        ),
        (
            "proxy authorization userinfo",
            "https://Proxy-Authorization='FAKE_USER'FAKE_TAIL@example.invalid/watch",
            "https://[redacted]@example.invalid/watch",
        ),
        (
            "set cookie userinfo",
            "https://Set-Cookie='FAKE_USER'FAKE_TAIL@example.invalid/watch",
            "https://[redacted]@example.invalid/watch",
        ),
        (
            "authorization query",
            "https://example.invalid/watch?Authorization='FAKE_HEAD'FAKE_TAIL",
            "https://example.invalid/watch?[redacted]",
        ),
        (
            "cookie fragment",
            "https://example.invalid/watch#Cookie='FAKE_HEAD'FAKE_TAIL",
            "https://example.invalid/watch#[redacted]",
        ),
        (
            "header-like wrapped URL",
            "Fetch 'https://Authorization='FAKE_USER'FAKE_TAIL@example.invalid/watch?Cookie='FAKE_HEAD'FAKE_TAIL' done.",
            "Fetch 'https://[redacted]@example.invalid/watch?[redacted]' done.",
        ),
        (
            "ordinary quoted URL",
            "Visit 'https://example.invalid/watch' when ready.",
            "Visit 'https://example.invalid/watch' when ready.",
        ),
        (
            "ordinary userinfo",
            "https://FAKE_USER:FAKE_PASS@example.invalid/watch",
            "https://[redacted]@example.invalid/watch",
        ),
    )
    failures = []
    for name, text, expected in cases:
        actual = redact(text)
        # OpenAI-Codex_web_ai: an ambiguous second URL is covered by the first query.
        if name == "adjacent quoted URLs":
            expected = "Links 'https://example.invalid/a?[redacted]'."
        if actual != expected:
            failures.append(name)
        elif redact(actual) != actual:
            failures.append(name + " idempotence")
    assert not failures, "synthetic URL cases failed: " + ", ".join(failures)




# OpenAI-Codex_engine_cli: raw double quotes must not expose URL private parts.
def _check_double_quote_urls():
    cases = (
        ("userinfo", 'https://FAKE_USER"FAKE_PART:FAKE_PASS@example.invalid/watch',
         ("FAKE_USER", "FAKE_PART", "FAKE_PASS")),
        ("query", 'https://example.invalid/watch?token=FAKE_HEAD"FAKE_TAIL',
         ("FAKE_HEAD", "FAKE_TAIL")),
        ("fragment", 'https://example.invalid/watch#FAKE_HEAD"FAKE_TAIL',
         ("FAKE_HEAD", "FAKE_TAIL")),
        ("quoted userinfo", 'Fetch "https://FAKE_USER"FAKE_PART:FAKE_PASS@example.invalid/watch" done.',
         ("FAKE_USER", "FAKE_PART", "FAKE_PASS")),
        ("quoted query", 'Fetch "https://example.invalid/watch?token=FAKE_HEAD"FAKE_TAIL" done.',
         ("FAKE_HEAD", "FAKE_TAIL")),
        ("header with URL", 'Authorization: Basic FAKE_AUTH https://example.invalid/watch?x=FAKE_HEAD"FAKE_TAIL',
         ("FAKE_AUTH", "FAKE_HEAD", "FAKE_TAIL")),
    )
    failures = []
    for name, text, markers in cases:
        actual = redact(text)
        if any(marker in actual for marker in markers):
            failures.append(name + " leaked")
        if redact(actual) != actual:
            failures.append(name + " not stable")
    ordinary = 'Visit "https://example.invalid/watch" when ready.'
    if redact(ordinary) != ordinary:
        failures.append("ordinary quoted URL changed")
    assert not failures, "synthetic double-quote URL failures: " + ", ".join(failures)

def main():
    examples = (
        ("Authorization: Basic FAKE_BASIC_42", "FAKE_BASIC_42"),
        ('{"Authorization":"Basic FAKE_JSON_42", "status":401}', "FAKE_JSON_42"),
        ('{"Cookie":"session=FAKE_COOKIE_42; theme=dark", "status":401}', "FAKE_COOKIE_42"),
        ("Proxy-Authorization: Negotiate FAKE_PROXY_42", "FAKE_PROXY_42"),
        ("Set-Cookie: session=FAKE_SET_42; Path=/", "FAKE_SET_42"),
        ("Authorization:\r\n  Basic FAKE_FOLDED_42", "FAKE_FOLDED_42"),
        (r'{"Authorization":"Basic FAKE_ESCAPE_42\"tail","status":401}', "FAKE_ESCAPE_42"),
        ("Bearer FAKE_BEARER_42", "FAKE_BEARER_42"),
        ('api_key="FAKE_KEY_42"', "FAKE_KEY_42"),
        ("access_token=FAKE_ACCESS_42", "FAKE_ACCESS_42"),
        ("REFRESH-TOKEN=FAKE_REFRESH_42", "FAKE_REFRESH_42"),
        ("password='FAKE_PASSWORD_42'", "FAKE_PASSWORD_42"),
        ("secret: FAKE_SECRET_42", "FAKE_SECRET_42"),
    )
    for text, marker in examples:
        safe = redact(text)
        assert marker not in safe
        assert "[redacted]" in safe
        assert redact(safe) == safe

    assert '"status":401' in redact(examples[1][0])
    assert redact("Conversion failed: unsupported media format") == "Conversion failed: unsupported media format"
    source = "Downloading https://FAKE_USER:FAKE_PASSWORD@example.invalid/watch?key=FAKE_QUERY#FAKE_FRAGMENT"
    assert redact(source) == "Downloading https://[redacted]@example.invalid/watch?[redacted]#[redacted]"
    multiple = "https://example.invalid/a and https://example.test/b?key=FAKE_QUERY."
    assert redact(multiple) == "https://example.invalid/a and https://example.test/b?[redacted]."

    # OpenAI-Codex_web_ai: verify apostrophe-bearing URLs and redaction stability.
    _check_apostrophe_urls()

    # OpenAI-Codex_engine_cli: preserve the raw double-quote regression checks.
    _check_double_quote_urls()

    # These examples document the best-effort boundary, not safe ways to store secrets.
    opaque = "X-Custom-Magic: FAKE_UNRECOGNIZED_42"
    url_path = "https://example.invalid/FAKE_PATH_COMPONENT_42"
    assert redact(opaque) == opaque
    assert redact(url_path) == url_path
    print(f"Synthetic standalone log redaction checks passed ({len(examples)} field cases).")


if __name__ == "__main__":
    main()
