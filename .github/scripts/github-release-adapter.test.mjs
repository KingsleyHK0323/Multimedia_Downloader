// OpenAI-Codex_release_threat: injected-fetch tests; no real network requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubReleaseAdapter as create } from './github-release-adapter.mjs';

const base = { token: 'test-only-secret', owner: 'owner', repo: 'repo' };
const sha = 'a'.repeat(40), bytes = new Uint8Array([1, 2, 3]);
const response = (status, value = {}) => ({ status, json: async () => value });
function mock(status = 200, value = {}) {
  const calls = [];
  return { calls, fetch: async (url, options) => { calls.push({ url, options }); return response(status, value); } };
}

test('configuration and encoded paths reject ambiguous input', async () => {
  const f = mock();
  for (const [owner, repo] of [['owner\n', 'repo'], ['owner', '../repo'], ['owner', '..'], ['a/b', 'repo']]) {
    assert.throws(() => create({ ...base, owner, repo, fetch: f.fetch }));
  }
  const a = create({ ...base, fetch: f.fetch });
  await assert.rejects(a.getReleaseByTag('v1.2.3\n'));
  assert.equal(f.calls.length, 0);
});

test('lookup distinguishes 200, 403 and 404 and does not follow redirects', async () => {
  for (const status of [200, 403, 404]) {
    const f = mock(status, { id: 1 }); const a = create({ ...base, fetch: f.fetch });
    assert.equal((await a.getReleaseByTag('v1.2.3')).status, status);
    assert.equal(f.calls[0].url, 'https://api.github.com/repos/owner/repo/releases/tags/v1.2.3');
    assert.equal(f.calls[0].options.redirect, 'manual');
    assert.equal(f.calls[0].options.headers.Authorization, 'Bearer test-only-secret');
  }
  const f = mock(302); await assert.rejects(create({ ...base, fetch: f.fetch }).getReleaseByTag('v1.2.3'));
  assert.equal(f.calls.length, 1);
});

test('release and asset readback expose status and bounded page results', async () => {
  const f = mock(200, []), a = create({ ...base, fetch: f.fetch });
  assert.equal((await a.getRelease(12)).status, 200);
  assert.deepEqual((await a.listAssets(12, 2)).data, []);
  assert.equal(f.calls[1].url, 'https://api.github.com/repos/owner/repo/releases/12/assets?per_page=100&page=2');
  await assert.rejects(a.listAssets(12, 1001));
  for (const status of [403, 404]) {
    const b = create({ ...base, fetch: mock(status).fetch });
    assert.equal((await b.listAssets(12, 1)).status, status);
    assert.equal((await b.getRelease(12)).status, status);
  }
});

test('draft creation is disabled without external tag protection evidence', async () => {
  const f = mock(201, { id: 1 }); const arg = { tag: 'v1.2.3', commitSha: sha, title: 'title', notes: 'notes' };
  await assert.rejects(create({ ...base, fetch: f.fetch }).createDraft(arg));
  await assert.rejects(create({ ...base, fetch: f.fetch, verifyTagProtection: async () => false }).createDraft(arg));
  assert.equal(f.calls.length, 0);
  const a = create({ ...base, fetch: f.fetch, verifyTagProtection: async () => true });
  assert.equal((await a.createDraft(arg)).id, 1);
  const call = f.calls[0];
  assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'manual');
  assert.deepEqual(JSON.parse(call.options.body), { tag_name: 'v1.2.3', target_commitish: sha, name: 'title', body: 'notes', draft: true });
});

test('upload requires draft verification and never deletes, overwrites or retries', async () => {
  const f = mock(201, { id: 2 });
  await assert.rejects(create({ ...base, fetch: f.fetch }).uploadAsset(1, 'app.exe', bytes));
  assert.equal(f.calls.length, 0);
  const a = create({ ...base, fetch: f.fetch, verifyDraft: async () => true });
  assert.equal((await a.uploadAsset(1, 'app.exe', bytes)).id, 2);
  assert.equal(f.calls[0].url, 'https://uploads.github.com/repos/owner/repo/releases/1/assets?name=app.exe');
  assert.equal(f.calls[0].options.method, 'POST'); assert.equal(f.calls[0].options.redirect, 'manual');
  for (const status of [422, 502]) {
    const bad = mock(status); const adapter = create({ ...base, fetch: bad.fetch, verifyDraft: async () => true });
    await assert.rejects(adapter.uploadAsset(1, 'app.exe', bytes));
    assert.equal(bad.calls.length, 1);
  }
});

test('upload snapshots bytes before the asynchronous draft check', async () => {
  const source = new Uint8Array([1, 2, 3]);
  const f = mock(201, { id: 2 });
  const a = create({ ...base, fetch: f.fetch, verifyDraft: async () => { source[0] = 9; return true; } });
  await a.uploadAsset(1, 'app.exe', source);
  assert.deepEqual(f.calls[0].options.body, new Uint8Array([1, 2, 3]));
  const shared = new Uint8Array(new SharedArrayBuffer(3));
  await assert.rejects(a.uploadAsset(1, 'app.exe', shared));
  await assert.rejects(a.uploadAsset(1, 'app.exe', new Uint8Array(0)));
});

test('download refuses redirects without disclosing signed URLs or forwarding token', async () => {
  const calls = [];
  const fetch = async (url, options) => { calls.push({ url, options }); return { status: 302, headers: new Headers({ Location: 'https://other.example/?sig=private' }) }; };
  const a = create({ ...base, fetch });
  await assert.rejects(a.downloadAsset(2, 1024), (error) => !error.message.includes('private'));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only-secret');
});

test('download enforces actual and declared byte limits', async () => {
  const stream = (parts) => new ReadableStream({ start(controller) { for (const p of parts) controller.enqueue(p); controller.close(); } });
  const make = (declared, parts) => create({ ...base, fetch: async () => ({ status: 200, headers: new Headers({ 'Content-Length': declared }), body: stream(parts) }) });
  assert.deepEqual(await make('3', [bytes]).downloadAsset(1, 3), bytes);
  await assert.rejects(make('2', [bytes]).downloadAsset(1, 3));
  await assert.rejects(make('4', [bytes]).downloadAsset(1, 4));
  await assert.rejects(make('3', [bytes]).downloadAsset(1, 2));
});

test('publication is disabled without external preconditions; failed writes do not retry', async () => {
  const f = mock(200, { id: 1, draft: false });
  await assert.rejects(create({ ...base, fetch: f.fetch }).publishDraft(1));
  assert.equal(f.calls.length, 0);
  const a = create({ ...base, fetch: f.fetch, verifyPublish: async () => true });
  assert.equal((await a.publishDraft(1)).draft, false);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { draft: false });
  assert.equal(f.calls[0].options.method, 'PATCH');
  const bad = mock(403); await assert.rejects(create({ ...base, fetch: bad.fetch, verifyPublish: async () => true }).publishDraft(1));
  assert.equal(bad.calls.length, 1);
});

test('transport exceptions are sanitized', async () => {
  const a = create({ ...base, fetch: async () => { throw new Error('test-only-secret https://signed.example'); } });
  await assert.rejects(a.getReleaseByTag('v1.2.3'), (error) => !error.message.includes('secret') && !error.message.includes('signed.example'));
  const b = create({ ...base, fetch: mock().fetch, verifyTagProtection: async () => { throw new Error('test-only-secret'); } });
  await assert.rejects(b.createDraft({ tag: 'v1.2.3', commitSha: sha, title: 't', notes: 'n' }), (error) => !error.message.includes('secret'));
});

test('hostile response getters and stream failures never expose secrets or signed URLs', async () => {
  const secret = 'test-only-secret https://signed.example/?sig=private';
  const fail = () => { throw new Error(secret); };
  const safe = (error) => !error.message.includes('secret') && !error.message.includes('signed.example') && !error.message.includes('private');
  const hostileStatus = () => ({ get status() { return fail(); } });
  const a = create({ ...base, fetch: async () => hostileStatus(), verifyTagProtection: async () => true,
    verifyDraft: async () => true, verifyPublish: async () => true });
  for (const call of [() => a.getReleaseByTag('v1.2.3'), () => a.getRelease(1), () => a.listAssets(1, 1),
    () => a.createDraft({ tag: 'v1.2.3', commitSha: sha, title: 't', notes: 'n' }),
    () => a.uploadAsset(1, 'app.exe', bytes), () => a.downloadAsset(1, 16), () => a.publishDraft(1)]) {
    await assert.rejects(call(), safe);
  }
  const hostileReplies = [
    { status: 200, get headers() { return fail(); } },
    { status: 200, headers: { get: fail } },
    { status: 200, headers: { get: () => '3' }, get body() { return fail(); } },
    { status: 200, headers: { get: () => '3' }, body: { get getReader() { return fail(); } } },
    { status: 200, headers: { get: () => '3' }, body: { getReader: () => ({ read: fail }) } },
  ];
  for (const reply of hostileReplies) {
    const adapter = create({ ...base, fetch: async () => reply });
    await assert.rejects(adapter.downloadAsset(1, 16), safe);
  }
  const jsonAdapter = create({ ...base, fetch: async () => ({ status: 200, get json() { return fail(); } }) });
  await assert.rejects(jsonAdapter.getRelease(1), safe);
});

test('response status is read once', async () => {
  let reads = 0;
  const adapter = create({ ...base, fetch: async () => ({ get status() { reads++; return reads === 1 ? 403 : 200; } }) });
  assert.deepEqual(await adapter.getRelease(1), { status: 403 });
  assert.equal(reads, 1);
});

