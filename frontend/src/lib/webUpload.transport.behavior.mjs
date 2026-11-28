// OpenAI-Codex_engine_cli: exercise upload replay without network or media files.
import assert from "node:assert/strict";

globalThis.fetch = async () => { throw new Error("Unexpected real network request"); };
const { readUploadConfig, uploadFile } = await import("./webUpload.ts");

const chunkBytes = 262144;
const config = { enabled: true, max_file_bytes: 1_000_000, max_total_bytes: 2_000_000, chunk_bytes: chunkBytes };
const uploadId = "03-0123456789abcdef0123456789abcdef";
const completedPath = ".mmdl-uploads-v1/slot-03/payload.mp4";

function fakeFile(size = 5) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  return {
    name: "sample.mp4", size, bytes,
    slice(start, end) { return { arrayBuffer: async () => bytes.slice(start, end).buffer }; },
  };
}

function fakeServer(target, actions = [], controller) {
  const calls = [];
  const attempts = { create: 0, chunk: 0, finish: 0 };
  let stored = Buffer.alloc(0);
  let lastChunk = null;
  let created = false;
  let finished = false;

  async function fetcher(url, request) {
    const stage = url === "/api/uploads" ? "create" :
      url === "/api/uploads/chunk" ? "chunk" : url === "/api/uploads/finish" ? "finish" : "unexpected";
    assert.notEqual(stage, "unexpected");
    assert.equal(request.method, "POST");
    assert.deepEqual(request.headers, { "Content-Type": "application/json" });
    calls.push({ stage, url, body: request.body, signal: request.signal, headers: request.headers });
    const body = JSON.parse(request.body);
    const attempt = attempts[stage]++;
    const action = stage === target ? (actions[attempt] ?? "ok") : "ok";
    if (action === "http") return { ok: false, status: 503, json: async () => { throw new Error("Unexpected error body read"); } };

    let value;
    if (stage === "create") {
      assert.equal(created, false, "A create replay would allocate another permanent slot");
      created = true;
      value = { upload_id: uploadId, chunk_bytes: chunkBytes, next_offset: 0 };
    } else if (stage === "chunk") {
      assert.equal(body.upload_id, uploadId);
      const bytes = Buffer.from(body.data_base64, "base64");
      if (body.offset === stored.length) {
        stored = Buffer.concat([stored, bytes]);
        lastChunk = { offset: body.offset, bytes };
      } else {
        assert.equal(body.offset, lastChunk?.offset, "Only the last committed chunk may be replayed");
        assert.deepEqual(bytes, lastChunk.bytes);
      }
      value = { next_offset: stored.length };
    } else {
      assert.equal(body.upload_id, uploadId);
      finished = true;
      value = { path: completedPath };
    }

    if (action === "network") throw new TypeError("Synthetic response loss after commit");
    return {
      ok: true, status: 200,
      json: async () => {
        if (action === "cancel") {
          controller.abort();
          throw new DOMException("Synthetic cancellation", "AbortError");
        }
        if (action === "abort") throw new DOMException("Synthetic detached abort", "AbortError");
        if (action === "body") throw new TypeError("Synthetic response body loss");
        if (action === "syntax") throw new SyntaxError("Synthetic invalid JSON");
        if (action === "shape") {
          if (stage === "create") return { ...value, next_offset: 1 };
          if (stage === "chunk") return { next_offset: -1 };
          return { path: ".mmdl-uploads-v1/slot-04/payload.mp4" };
        }
        return value;
      },
    };
  }

  return { fetcher, calls, attempts, state: () => ({ stored, created, finished }) };
}

function assertSameRequest(calls) {
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.deepEqual(calls[0].headers, calls[1].headers);
}

for (const stage of ["chunk", "finish"]) {
  const file = fakeFile(stage === "chunk" ? chunkBytes + 3 : 5);
  const server = fakeServer(stage, ["body"]);
  const progress = [];
  assert.equal(await uploadFile(file, config, {
    fetcher: server.fetcher, onProgress: (value) => progress.push(value),
  }), completedPath);
  const calls = server.calls.filter((call) => call.stage === stage);
  assertSameRequest(calls.slice(0, 2));
  assert.equal(calls.length, stage === "chunk" ? 3 : 2);
  assert.deepEqual(server.state().stored, Buffer.from(file.bytes));
  assert.equal(server.state().finished, true);
  assert.equal(progress.at(-1).phase, "finalizing");
  assert.equal(progress.at(-1).sent, file.size);

  for (const actions of [["body", "body"], ["network", "body"], ["body", "network"], ["syntax", "syntax"]]) {
    const repeated = fakeServer(stage, actions);
    await assert.rejects(() => uploadFile(fakeFile(), config, { fetcher: repeated.fetcher }),
      (error) => error.kind === "unconfirmed");
    assertSameRequest(repeated.calls.filter((call) => call.stage === stage));
    if (stage === "chunk") assert.equal(repeated.attempts.finish, 0);
  }

  const controller = new AbortController();
  const cancelled = fakeServer(stage, ["cancel"], controller);
  await assert.rejects(() => uploadFile(fakeFile(), config, {
    fetcher: cancelled.fetcher, signal: controller.signal,
  }), (error) => error.kind === "cancelled");
  assert.equal(cancelled.attempts[stage], 1);
  if (stage === "chunk") assert.equal(cancelled.attempts.finish, 0);

  const detached = fakeServer(stage, ["abort"]);
  await assert.rejects(() => uploadFile(fakeFile(), config, { fetcher: detached.fetcher }),
    (error) => error.kind === "unconfirmed");
  assert.equal(detached.attempts[stage], 1);
}

const lostCreate = fakeServer("create", ["body"]);
await assert.rejects(() => uploadFile(fakeFile(), config, { fetcher: lostCreate.fetcher }),
  (error) => error.kind === "unconfirmed");
assert.equal(lostCreate.attempts.create, 1);
assert.equal(lostCreate.calls.length, 1);
assert.equal(lostCreate.state().created, true);

for (const stage of ["create", "chunk", "finish"]) {
  for (const [action, kind] of [["http", "server"], ["shape", "protocol"]]) {
    const server = fakeServer(stage, [action]);
    await assert.rejects(() => uploadFile(fakeFile(), config, { fetcher: server.fetcher }),
      (error) => error.kind === kind);
    assert.equal(server.attempts[stage], 1);
    if (stage !== "finish") assert.equal(server.attempts.finish, 0);
  }
}

const preAborted = new AbortController();
preAborted.abort();
const notStarted = fakeServer();
await assert.rejects(() => uploadFile(fakeFile(), config, { fetcher: notStarted.fetcher, signal: preAborted.signal }),
  (error) => error.kind === "cancelled");
assert.equal(notStarted.calls.length, 0);

let configCalls = 0;
await assert.rejects(() => readUploadConfig(async () => {
  configCalls++;
  return { ok: true, json: async () => { throw new TypeError("Synthetic config response loss"); } };
}), (error) => error.kind === "config");
assert.equal(configCalls, 1);

console.log("Memory-only upload transport checks passed.");
