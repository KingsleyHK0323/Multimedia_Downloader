"""OpenAI-Codex_app_ui: in-memory checks with invented diagnostic values."""

import importlib.util
import ast
from pathlib import Path
from types import SimpleNamespace

source = Path(__file__).resolve().parents[1] / "engine" / "log_safety.py"
spec = importlib.util.spec_from_file_location("synthetic_log_safety", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

examples = [
    ("Authorization: Basic SYNTHETIC_BASIC_42", "SYNTHETIC_BASIC_42"),
    ('{"Authorization":"Basic SYNTHETIC_JSON_42", "status":401}', "SYNTHETIC_JSON_42"),
    ('{"Cookie":"session=SYNTHETIC_COOKIE_42; theme=dark", "status":401}', "SYNTHETIC_COOKIE_42"),
    ("Proxy-Authorization: Negotiate SYNTHETIC_PROXY_42", "SYNTHETIC_PROXY_42"),
    ("Set-Cookie: session=SYNTHETIC_SET_42; Path=/", "SYNTHETIC_SET_42"),
    ("Authorization:\r\n  Basic SYNTHETIC_FOLDED_42", "SYNTHETIC_FOLDED_42"),
    (r'{"Authorization":"Basic SYNTHETIC_ESCAPE_42\"tail","status":401}', "SYNTHETIC_ESCAPE_42"),
    ("Bearer SYNTHETIC_BEARER_42", "SYNTHETIC_BEARER_42"),
    ('api_key="SYNTHETIC_KEY_42"', "SYNTHETIC_KEY_42"),
]
for text, marker in examples:
    safe = module.redact_sensitive_urls(text)
    assert marker not in safe, f"synthetic {marker} must be redacted"
    assert "[redacted]" in safe
    assert module.redact_sensitive_urls(safe) == safe

assert '"status":401' in module.redact_sensitive_urls(examples[1][0])
plain = "Conversion failed: unsupported media format"
assert module.redact_sensitive_urls(plain) == plain
url = module.redact_sensitive_urls("Fetching https://example.invalid/media?token=SYNTHETIC_URL_42#SYNTHETIC_FRAGMENT_42")
assert "SYNTHETIC_URL_42" not in url and "SYNTHETIC_FRAGMENT_42" not in url
assert "example.invalid/media" in url
url_with_credentials = "Downloading https://SYNTHETIC_USER:SYNTHETIC_PASS@example.invalid/watch?token=SYNTHETIC_QUERY#SYNTHETIC_FRAGMENT"
assert module.redact_sensitive_urls(url_with_credentials) == "Downloading https://[redacted]@example.invalid/watch?[redacted]#[redacted]"
multiple = "https://example.invalid/a and https://example.test/b?key=SYNTHETIC_QUERY."
assert module.redact_sensitive_urls(multiple) == "https://example.invalid/a and https://example.test/b?[redacted]."

# Execute the actual downloader class and classifier with a fake download method;
# no yt-dlp import, network, media, sleep, or filesystem writes are involved.
root = Path(__file__).resolve().parents[1]
errors_spec = importlib.util.spec_from_file_location("synthetic_engine_errors", root / "engine" / "errors.py")
errors = importlib.util.module_from_spec(errors_spec)
errors_spec.loader.exec_module(errors)
options_tree = ast.parse((root / "engine" / "options.py").read_text(encoding="utf-8"))
summary_node = next(node for node in options_tree.body if isinstance(node, ast.FunctionDef) and node.name == "batch_summary")
downloader_tree = ast.parse((root / "engine" / "downloader.py").read_text(encoding="utf-8"))
downloader_node = next(node for node in downloader_tree.body if isinstance(node, ast.ClassDef) and node.name == "Downloader")
future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
synthetic_module = ast.fix_missing_locations(ast.Module(body=[future, summary_node, downloader_node], type_ignores=[]))
fake_time = SimpleNamespace(sleep=lambda _seconds: None)
scope = {"classify": errors.classify, "is_stale_tool": errors.is_stale_tool,
         "ErrorKind": errors.ErrorKind, "OperationCancelled": errors.OperationCancelled,
         "redact_sensitive_urls": module.redact_sensitive_urls,
         "time": fake_time, "_MAX_RETRIES": 2, "_RETRY_DELAY_S": 2}
exec(compile(synthetic_module, "<synthetic-downloader>", "exec"), scope)  # noqa: S102 - Execute only repository AST with fake dependencies.
raw_url = "https://example.invalid/media?token=SYNTHETIC_INPUT_42"
attempted, starts, log_events = [], [], []
downloader = scope["Downloader"](object(), log_cb=lambda level, key, **fmt: log_events.append((level, key, fmt)),
                                  item_start_cb=lambda _index, _total, value: starts.append(value))
downloader.download_one = lambda value: attempted.append(value)
result = downloader.download_batch([raw_url])
assert attempted == [raw_url] and starts == [raw_url] and result[0][0] == raw_url
assert "SYNTHETIC_INPUT_42" not in repr(log_events)
assert result[0][1] is True

attempted.clear()
log_events.clear()
def fail_with_synthetic_auth(value):
    attempted.append(value)
    raise RuntimeError("HTTP Error 403: Forbidden\nAuthorization: Basic SYNTHETIC_RETRY_42")
downloader.download_one = fail_with_synthetic_auth
failed = downloader.download_batch([raw_url])
assert attempted == [raw_url] * 3 and failed[0][0] == raw_url and failed[0][1] is False
assert "SYNTHETIC_RETRY_42" not in failed[0][2] and "SYNTHETIC_RETRY_42" not in repr(log_events)
assert any(key == "log_hint_outdated" for _level, key, _fmt in log_events)
assert errors.classify(FileNotFoundError()) is errors.ErrorKind.NO_FFMPEG
print("Synthetic backend log redaction checks passed.")
