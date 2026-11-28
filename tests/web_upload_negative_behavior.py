"""Memory-only negative checks for the current upload route and storage core.

OpenAI-Codex_engine_cli: this does not start Flask, access a real upload path,
use real media, open a listener, or clean up retained data.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import ntpath
from pathlib import Path


BRIDGE = Path(__file__).absolute().with_name("web_upload_memory_bridge.py")
SPEC = importlib.util.spec_from_file_location("upload_memory_bridge", BRIDGE)
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)

SETTINGS = {
    "MMDL_UPLOAD_MAX_FILE_BYTES": str(524288),
    "MMDL_UPLOAD_MAX_TOTAL_BYTES": str(3000000),
}
CHUNK = 262144


def encoded(data):
    return base64.b64encode(data).decode("ascii")


def post(service, url, value):
    return service.request(
        {
            "url": url,
            "method": "POST",
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(value),
        }
    )


def send_chunk(service, upload_id, offset, data_base64):
    return post(
        service,
        "/api/uploads/chunk",
        {
            "upload_id": upload_id,
            "offset": offset,
            "data_base64": data_base64,
        },
    )


def convert(service, source):
    return post(
        service,
        "/api/convert",
        {
            "operation_id": "synthetic-negative-check",
            "files": [source],
            "dst_fmt": "mp4",
            "save_path": "",
        },
    )


def main():
    service = bridge.FakeWeb(SETTINGS)
    created = post(
        service, "/api/uploads", {"name": "synthetic.mp4", "size": CHUNK + 3}
    )
    assert created["status"] == 200
    upload_id = created["body"]["upload_id"]
    source = ".mmdl-uploads-v1/slot-00/payload.mp4"
    empty = service.files.snapshot(upload_id)
    assert empty["bytes"] == 0 and empty["journal_bytes"] == 0
    assert not empty["completed"]

    assert convert(service, source)["status"] == 403
    assert send_chunk(service, upload_id, 0, "%%%")["status"] == 400
    assert send_chunk(service, upload_id, 0, encoded(b"bad"))["status"] == 400
    assert send_chunk(service, upload_id, 5, encoded(b"bad"))["status"] == 409
    too_large = send_chunk(service, upload_id, 0, "A" * 400000)
    assert too_large["status"] == 413
    assert service.files.snapshot(upload_id) == empty

    first = b"x" * CHUNK
    first_body = encoded(first)
    committed = send_chunk(service, upload_id, 0, first_body)
    assert committed == {"status": 200, "body": {"next_offset": CHUNK}}
    first_snapshot = service.files.snapshot(upload_id)
    assert first_snapshot["bytes"] == CHUNK and first_snapshot["journal_bytes"] == 98
    assert first_snapshot["sha256"] == hashlib.sha256(first).hexdigest()
    assert send_chunk(service, upload_id, 0, first_body) == committed
    assert send_chunk(service, upload_id, 0, encoded(b"y" * CHUNK))["status"] == 409
    assert send_chunk(service, upload_id, CHUNK + 1, encoded(b"end"))["status"] == 409
    assert send_chunk(service, upload_id, CHUNK, encoded(b"long"))["status"] == 400
    assert (
        post(service, "/api/uploads/finish", {"upload_id": upload_id})["status"] == 409
    )
    assert service.files.snapshot(upload_id) == first_snapshot

    assert send_chunk(service, upload_id, CHUNK, encoded(b"end")) == {
        "status": 200,
        "body": {"next_offset": CHUNK + 3},
    }
    finished = post(service, "/api/uploads/finish", {"upload_id": upload_id})
    assert finished == {"status": 200, "body": {"path": source}}
    assert post(service, "/api/uploads/finish", {"upload_id": upload_id}) == finished
    assert send_chunk(service, upload_id, CHUNK, encoded(b"end"))["status"] == 409
    assert service.files.snapshot(upload_id)["completed"]
    assert convert(service, source)["status"] == 200
    assert service.convert_calls == 1

    # Simulate an unrelated local modification in fake memory before finish.
    damaged = bridge.FakeWeb(SETTINGS)
    created = post(damaged, "/api/uploads", {"name": "damage.mp4", "size": 3})
    damaged_id = created["body"]["upload_id"]
    assert send_chunk(damaged, damaged_id, 0, encoded(b"abc"))["status"] == 200
    payload = ntpath.join(
        damaged.files.cwd,
        "downloads",
        ".mmdl-uploads-v1",
        "slot-00",
        "payload.mp4",
    )
    damaged.files.nodes[damaged.files.key(payload)]["data"][0] ^= 1
    # Restore the synthetic bytes; the next original comment records historical behavior.
    damaged.files.nodes[damaged.files.key(payload)]["data"][0] ^= 1
    # A replay acknowledgement does not rehash the stored payload; finish does.
    assert send_chunk(damaged, damaged_id, 0, encoded(b"abc"))["status"] == 200
    # OpenAI-Codex_engine_cli: a damaged last chunk must no longer be acknowledged.
    damaged.files.nodes[damaged.files.key(payload)]["data"][0] ^= 1
    replay = send_chunk(damaged, damaged_id, 0, encoded(b"abc"))
    assert replay["status"] == 409 and replay["body"]["error_code"] == "interrupted"
    failure = post(damaged, "/api/uploads/finish", {"upload_id": damaged_id})
    assert failure["status"] == 409 and failure["body"]["error_code"] == "interrupted"
    assert not damaged.files.snapshot(damaged_id)["completed"]
    assert convert(damaged, source)["status"] == 403
    assert damaged.convert_calls == 0
    print(
        "Memory-only malformed, replay, premature-finish, and damaged-payload checks passed."
    )


if __name__ == "__main__":
    main()
