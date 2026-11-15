// OpenAI-Codex_Fork_GitHub_REPO: standalone regression coverage.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyReleaseJsonVersionText as text, classifyReleaseJsonVersionBytes as bytes } from "./protected-release-json-policy.mjs";

const encoder = new TextEncoder();
const prior = '{"version":"1.2.3"}';
const next = '{"version":"1.2.4"}';
const byteCheck = (a, b) => bytes("package.json", a, b, "1.2.3");

test("numeric policy accepts safe integers and rejects ambiguous forms", () => {
  for (const token of ["0", "1", "-1", "9007199254740991", "-9007199254740991"]) {
    const a = `{"version":"1.2.3","n":${token}}`;
    assert.equal(text("package.json", a, a.replace("1.2.3", "1.2.4"), "1.2.3").ok, true, token);
  }
  for (const token of ["-0", "1.0", "0.1", "1e0", "1e-9999", "1e999", "9007199254740992", "-9007199254740992"]) {
    const a = `{"version":"1.2.3","n":${token}}`;
    assert.equal(text("package.json", a, a.replace("1.2.3", "1.2.4"), "1.2.3").ok, false, token);
  }
});

test("byte validation accepts valid UTF-8 and does not authorize a merge", () => {
  for (const value of ["😀", "�"]) {
    const a = `{"version":"1.2.3","value":"${value}"}`;
    const result = byteCheck(encoder.encode(a), encoder.encode(a.replace("1.2.3", "1.2.4")));
    assert.equal(result.ok, true);
    assert.equal(result.utf8Validated, true);
    assert.equal(result.mergeAuthorized, false);
    assert.equal(result.completeRelease, false);
  }
});

test("byte validation rejects malformed, BOM, shared and oversized input", () => {
  const a = encoder.encode(prior), b = encoder.encode(next);
  for (const invalid of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xef, 0xbb, 0xbf, ...a], [0xff]]) {
    assert.equal(byteCheck(Uint8Array.from(invalid), b).ok, false);
    assert.equal(byteCheck(a, Uint8Array.from(invalid)).ok, false);
  }
  assert.equal(byteCheck(a, "not bytes").ok, false);
  assert.equal(byteCheck(new Uint8Array(new SharedArrayBuffer(a.length)), b).ok, false);
  assert.equal(byteCheck(new Uint8Array(12_000_001), b).ok, false);
});

test("byte validation reads actual bytes despite subclass overrides", () => {
  class Forged extends Uint8Array {
    *[Symbol.iterator]() { yield* encoder.encode(prior); }
    get buffer() { throw new Error("poisoned getter"); }
  }
  const result = byteCheck(new Forged([0xff, 0xff]), encoder.encode(next));
  assert.equal(result.ok, false);
  assert.notEqual(result.utf8Validated, true);
});

test("version change does not allow unrelated edits or duplicate keys", () => {
  assert.equal(byteCheck(encoder.encode(prior), encoder.encode('{"version":"1.2.4","x":1}')).ok, false);
  const duplicate = '{"version":"1.2.3","\\u0076ersion":"1.2.3"}';
  assert.equal(text("package.json", duplicate, duplicate.replaceAll("1.2.3", "1.2.4"), "1.2.3").ok, false);
});

test("all allowed paths enforce their required version fields", () => {
  for (const path of ["package.json", "frontend/package.json", "src-tauri/tauri.conf.json"]) {
    assert.equal(text(path, prior, next, "1.2.3").ok, true, path);
  }
  for (const path of ["package-lock.json", "frontend/package-lock.json"]) {
    const a = '{"version":"1.2.3","packages":{"":{"version":"1.2.3"}}}';
    const b = a.replaceAll("1.2.3", "1.2.4");
    assert.equal(text(path, a, b, "1.2.3").ok, true, path);
    assert.equal(text(path, a, a.replace("1.2.3", "1.2.4"), "1.2.3").ok, false);
    assert.equal(text(path, prior, next, "1.2.3").ok, false);
    const mismatch = '{"version":"1.2.3","packages":{"":{"version":"1.2.2"}}}';
    assert.equal(text(path, mismatch, mismatch.replace("1.2.3", "1.2.4"), "1.2.3").ok, false);
  }
  assert.equal(text("unknown.json", prior, next, "1.2.3").ok, false);
});

