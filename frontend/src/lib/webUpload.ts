// OpenAI-Codex_engine_cli: bounded same-origin upload transport; no cleanup or implicit create retry.
const CHUNK_BYTES = 262144;
const reasons = new Set(["not_configured", "invalid_configuration", "insufficient_total", "unrestricted_paths", "unsupported_platform"]);

export type UploadConfig =
  | { enabled: false; reason: string }
  | { enabled: true; max_file_bytes: number; max_total_bytes: number; chunk_bytes: number };
export type UploadProgress = { sent: number; total: number; phase: "uploading" | "finalizing" };
export type UploadFile = Pick<File, "name" | "size" | "slice">;
export type UploadErrorKind = "config" | "invalid_file" | "server" | "protocol" | "unconfirmed" | "cancelled";

export class UploadError extends Error {
  readonly kind: UploadErrorKind;
  constructor(kind: UploadErrorKind) {
    super(kind);
    this.kind = kind;
  }
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UploadError("cancelled");
}

function validEnabledConfig(value: unknown): value is Extract<UploadConfig, { enabled: true }> {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return config.enabled === true && Number.isSafeInteger(config.max_file_bytes) &&
    (config.max_file_bytes as number) > 0 && Number.isSafeInteger(config.max_total_bytes) &&
    (config.max_total_bytes as number) > 0 && config.chunk_bytes === CHUNK_BYTES;
}

export async function readUploadConfig(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<UploadConfig> {
  try {
    cancelled(signal);
    const response = await fetcher("/api/uploads/config", { method: "GET", cache: "no-store", signal });
    if (!response.ok) throw new UploadError("config");
    const value: unknown = await response.json();
    cancelled(signal);
    if (validEnabledConfig(value)) return { enabled: true, max_file_bytes: value.max_file_bytes,
      max_total_bytes: value.max_total_bytes, chunk_bytes: value.chunk_bytes };
    if (value && typeof value === "object" && (value as Record<string, unknown>).enabled === false) {
      const reason = (value as Record<string, unknown>).reason;
      return { enabled: false, reason: typeof reason === "string" && reasons.has(reason) ? reason : "unknown" };
    }
  } catch (error) {
    if (signal?.aborted) throw new UploadError("cancelled");
    if (error instanceof UploadError && error.kind === "cancelled") throw error;
    throw new UploadError("config");
  }
  throw new UploadError("config");
}

export function isValidUploadFile(file: UploadFile | null, config: UploadConfig | null): boolean {
  if (!file || !validEnabledConfig(config) || typeof file.name !== "string" || typeof file.slice !== "function" ||
      !Number.isSafeInteger(file.size) || file.size < 0 || file.size > config.max_file_bytes ||
      file.size > config.max_total_bytes) return false;
  if (file.name === "." || file.name === "..") return false;
  const chars = Array.from(file.name);
  if (!chars.length || chars.length > 255 || new TextEncoder().encode(file.name).length > 1024) return false;
  return !chars.some((char) => {
    const point = char.codePointAt(0)!;
    return char === "/" || char === "\\" || point < 32 || (point >= 127 && point <= 159) ||
      (point >= 0xd800 && point <= 0xdfff);
  });
}

function base64Chunk(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function postJson(fetcher: typeof fetch, url: string, body: object,
                        signal: AbortSignal | undefined, retryNetworkOnce: boolean): Promise<unknown> {
  const encoded = JSON.stringify(body);
  for (let attempt = 0; attempt <= (retryNetworkOnce ? 1 : 0); attempt++) {
    cancelled(signal);
    let response: Response;
    try {
      response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: encoded, signal });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw new UploadError("cancelled");
      if (attempt === 0 && retryNetworkOnce) continue;
      throw new UploadError("unconfirmed");
    }
    cancelled(signal);
    if (!response.ok) throw new UploadError("server");
    try {
      const value: unknown = await response.json();
      cancelled(signal);
      return value;
    } catch (error) {
      if (signal?.aborted || (error instanceof UploadError && error.kind === "cancelled")) throw new UploadError("cancelled");
      // OpenAI-Codex_web_ai: retry a lost response body only for replay-safe calls.
      if (attempt === 0 && retryNetworkOnce && !(error instanceof Error && error.name === "AbortError")) continue;
      throw new UploadError("unconfirmed");
    }
  }
  throw new UploadError("unconfirmed");
}

export async function uploadFile(file: UploadFile, config: UploadConfig, options: {
  fetcher?: typeof fetch; signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void;
} = {}): Promise<string> {
  if (!isValidUploadFile(file, config)) throw new UploadError("invalid_file");
  const fetcher = options.fetcher ?? fetch;
  const signal = options.signal;
  cancelled(signal);
  const created = await postJson(fetcher, "/api/uploads", {name:file.name, size:file.size}, signal, false);
  if (!created || typeof created !== "object") throw new UploadError("protocol");
  const start = created as Record<string, unknown>;
  if (typeof start.upload_id !== "string" || !/^[0-9]{2}-[0-9a-f]{32}$/.test(start.upload_id) ||
      start.chunk_bytes !== CHUNK_BYTES || start.next_offset !== 0) throw new UploadError("protocol");
  const uploadId = start.upload_id;
  let sent = 0;
  options.onProgress?.({sent,total:file.size,phase:"uploading"});
  while (sent < file.size) {
    cancelled(signal);
    const end = Math.min(sent + CHUNK_BYTES, file.size);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await file.slice(sent, end).arrayBuffer()); }
    catch { throw new UploadError(signal?.aborted ? "cancelled" : "unconfirmed"); }
    cancelled(signal);
    if (bytes.length !== end - sent) throw new UploadError("unconfirmed");
    const response = await postJson(fetcher, "/api/uploads/chunk", {
      upload_id:uploadId, offset:sent, data_base64:base64Chunk(bytes),
    }, signal, true);
    if (!response || typeof response !== "object" || (response as Record<string, unknown>).next_offset !== end) {
      throw new UploadError("protocol");
    }
    sent = end;
    options.onProgress?.({sent,total:file.size,phase:"uploading"});
  }
  cancelled(signal);
  options.onProgress?.({sent,total:file.size,phase:"finalizing"});
  const finished = await postJson(fetcher, "/api/uploads/finish", {upload_id:uploadId}, signal, true);
  const path = finished && typeof finished === "object" ? (finished as Record<string, unknown>).path : undefined;
  if (typeof path !== "string") throw new UploadError("protocol");
  const match = /^\.mmdl-uploads-v1\/slot-([0-9]{2})\/payload\.[a-z0-9]{1,10}$/.exec(path);
  if (!match || match[1] !== uploadId.slice(0, 2)) throw new UploadError("protocol");
  cancelled(signal);
  return path;
}
