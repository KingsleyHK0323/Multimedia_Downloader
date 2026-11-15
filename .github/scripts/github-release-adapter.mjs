// OpenAI-Codex_release_threat: review-only GitHub REST adapter; never runs on import.
// Caller must establish authorization, verified source/bytes and server-side rules.
// Prechecks are not atomic with API writes and cannot guarantee that GitHub will
// not create a tag if it disappears between a check and release creation.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?![\s\S])/;
const REPO = /^[A-Za-z0-9_.-]{1,100}(?![\s\S])/;
const TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?![\s\S])/;
const SHA = /^[0-9a-f]{40}(?![\s\S])/;
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}(?![\s\S])/;
const ID = (value) => Number.isSafeInteger(value) && value > 0;

export function createGitHubReleaseAdapter({ fetch: request, token, owner, repo, verifyTagProtection, verifyDraft, verifyPublish } = {}) {
  if (typeof request !== 'function' || typeof token !== 'string' || !token || /[\r\n]/.test(token) ||
      typeof owner !== 'string' || !OWNER.test(owner) || typeof repo !== 'string' || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new Error('invalid adapter configuration');
  }
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const send = async (host, path, options = {}) => {
    // Fixed hosts and manual redirects prevent credentials following redirects.
    let response;
    try { response = await request(`https://${host}${path}`, { ...options, redirect: 'manual' }); }
    catch { throw new Error('GitHub request failed'); }
    if (!response) throw new Error('invalid GitHub response');
    const status = response.status;
    if (!Number.isInteger(status)) throw new Error('invalid GitHub response');
    return { status, raw: response };
  };
  const json = async (response) => {
    try { return await response.raw.json(); } catch { throw new Error('invalid GitHub JSON response'); }
  };
  const verified = async (callback, args) => {
    try { return typeof callback === 'function' && await callback(args) === true; }
    catch { return false; }
  };
  const tagOK = (tag) => typeof tag === 'string' && tag.length <= 51 && TAG.test(tag);
  const methods = {
    async getReleaseByTag(tag) {
      if (!tagOK(tag)) throw new Error('invalid tag');
      const response = await send('api.github.com', `${prefix}/releases/tags/${encodeURIComponent(tag)}`, { headers });
      if (response.status === 404 || response.status === 403) return { status: response.status };
      if (response.status !== 200) throw new Error(`release lookup failed (${response.status})`);
      return { status: 200, data: await json(response) };
    },
    async getRelease(releaseId) {
      if (!ID(releaseId)) throw new Error('invalid release id');
      const response = await send('api.github.com', `${prefix}/releases/${releaseId}`, { headers });
      if (response.status === 404 || response.status === 403) return { status: response.status };
      if (response.status !== 200) throw new Error(`release lookup failed (${response.status})`);
      return { status: 200, data: await json(response) };
    },
    async listAssets(releaseId, page) {
      if (!ID(releaseId) || !ID(page) || page > 1000) throw new Error('invalid asset page');
      const response = await send('api.github.com', `${prefix}/releases/${releaseId}/assets?per_page=100&page=${page}`, { headers });
      if (response.status === 404 || response.status === 403) return { status: response.status };
      if (response.status !== 200) throw new Error(`asset listing failed (${response.status})`);
      const data = await json(response);
      if (!Array.isArray(data) || data.length > 100) throw new Error('invalid asset listing');
      return { status: 200, data };
    },
    async createDraft({ tag, commitSha, title, notes }) {
      if (!tagOK(tag) || typeof commitSha !== 'string' || !SHA.test(commitSha) ||
          typeof title !== 'string' || typeof notes !== 'string') throw new Error('invalid draft input');
      // This callback must independently establish enforced, non-bypassable
      // server-side tag protection for the actual actor. It is not a proof itself.
      if (!await verified(verifyTagProtection, { owner, repo, tag, commitSha })) {
        throw new Error('verified tag protection required');
      }
      const response = await send('api.github.com', `${prefix}/releases`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_name: tag, target_commitish: commitSha, name: title, body: notes, draft: true }),
      });
      if (response.status !== 201) throw new Error(`draft creation failed (${response.status})`);
      return await json(response);
    },
    async uploadAsset(releaseId, name, bytes) {
      if (!ID(releaseId) || typeof name !== 'string' || !ASSET.test(name) || !(bytes instanceof Uint8Array)) {
        throw new Error('invalid asset input');
      }
      let snapshot;
      try {
        const proto = Object.getPrototypeOf(Uint8Array.prototype);
        const get = (name) => Object.getOwnPropertyDescriptor(proto, name).get.call(bytes);
        const buffer = get('buffer'), offset = get('byteOffset'), length = get('byteLength');
        const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
        if (!(buffer instanceof ArrayBuffer) || length < 1 || length > 512 * 1024 * 1024 || (resizable && resizable.call(buffer))) throw new Error();
        snapshot = new Uint8Array(length);
        Uint8Array.prototype.set.call(snapshot, new Uint8Array(buffer, offset, length));
      } catch { throw new Error('invalid asset input'); }
      if (!await verified(verifyDraft, { owner, repo, releaseId })) {
        throw new Error('verified new draft required');
      }
      const response = await send('uploads.github.com', `${prefix}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: snapshot,
      });
      // 422 may indicate an existing name; 502 may leave a starter. Never retry or delete.
      if (response.status !== 201) throw new Error(`asset upload failed (${response.status})`);
      return await json(response);
    },
    async downloadAsset(assetId, maxBytes) {
      if (!ID(assetId) || !ID(maxBytes) || maxBytes > 512 * 1024 * 1024) throw new Error('invalid download input');
      const response = await send('api.github.com', `${prefix}/releases/assets/${assetId}`, {
        headers: { ...headers, Accept: 'application/octet-stream' },
      });
      // GitHub may return 302 with a signed URL. Do not follow or expose it.
      if (response.status !== 200) throw new Error(`asset download unavailable (${response.status})`);
      const replyHeaders = response.raw.headers;
      const body = response.raw.body;
      const declared = replyHeaders?.get('content-length');
      const getReader = body?.getReader;
      if (!declared || !/^[1-9][0-9]*$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes ||
          typeof getReader !== 'function') throw new Error('invalid asset length');
      const reader = getReader.call(body);
      const read = reader.read;
      if (typeof read !== 'function') throw new Error('invalid asset stream');
      const chunks = []; let total = 0;
      try {
        for (;;) {
          const { done, value } = await read.call(reader);
          if (done) break;
          if (!(value instanceof Uint8Array)) throw new Error('invalid chunk');
          total += value.byteLength;
          if (total > maxBytes || total > Number(declared)) throw new Error('asset exceeds limit');
          chunks.push(value.slice());
        }
      } catch { throw new Error('asset download failed'); }
      if (total !== Number(declared)) throw new Error('asset length mismatch');
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    },
    async publishDraft(releaseId) {
      if (!ID(releaseId)) throw new Error('invalid release id');
      // External verification is necessary, but cannot make the final write atomic.
      if (!await verified(verifyPublish, { owner, repo, releaseId })) {
        throw new Error('verified publication preconditions required');
      }
      const response = await send('api.github.com', `${prefix}/releases/${releaseId}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false }),
      });
      if (response.status !== 200) throw new Error(`release publication failed (${response.status})`);
      return await json(response);
    },
  };
  // OpenAI-Codex_release_threat: injected responses, getters and streams are
  // untrusted. Do not expose their error messages, URLs or credentials.
  return Object.freeze(Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, async (...args) => {
    try { return await method(...args); }
    catch { throw new Error('GitHub adapter operation failed'); }
  }])));
}

