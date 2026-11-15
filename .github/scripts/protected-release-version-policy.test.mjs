// OpenAI-Codex_Fork_GitHub_REPO: conservative version classifier regressions.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyReleaseVersionText as classify } from "./protected-release-version-policy.mjs";

const oldVersion = "1.2.3";
const next = (text) => text.replace("1.2.3", "1.2.4");
const check = (path, before, after = next(before)) => classify(path, before, after, oldVersion);
const examples = [
  ["README.md", "# Multimedia Downloader — V1.2.3\n"],
  ["engine/__init__.py", '__version__ = "1.2.3"\n'],
  ["src-tauri/Cargo.toml", '[package]\nname = "example"\nversion = "1.2.3"\n'],
  ["src-tauri/Cargo.lock", '[[package]]\nname = "multimedia-downloader"\nversion = "1.2.3"\n'],
];

test("accepts selected version-only text while never authorizing merge", () => {
  for (const [path, before] of examples) {
    const result = check(path, before);
    assert.equal(result.ok, true, path);
    assert.equal(result.nextVersion, "1.2.4");
    assert.equal(result.completeRelease, false);
    assert.equal(result.mergeAuthorized, false);
    assert.equal(check(path, before, next(before) + "additional edit\n").ok, false);
  }
});

test("rejects ambiguous Python references and multiline strings", () => {
  const prefix = '__version__ = "1.2.3"\n';
  for (const suffix of [
    'if True:\n    __version__ = "9.9.9"\n',
    'globals()["__version__"] = "9.9.9"\n',
    '(__version__ := "9.9.9")\n',
    '# __version__ mentioned\n',
    'x = """multiline"""\n',
  ]) assert.equal(check("engine/__init__.py", prefix + suffix).ok, false, suffix);
});

test("rejects ambiguous TOML and lockfile package declarations", () => {
  const toml = '[package]\nversion = "1.2.3"\nversion = "9.9.9"\n';
  const lock = '[[package]]\nname = "multimedia-downloader"\nversion = "1.2.3"\nversion = "9.9.9"\n';
  assert.equal(check("src-tauri/Cargo.toml", toml).ok, false);
  assert.equal(check("src-tauri/Cargo.lock", lock).ok, false);
  assert.equal(check("src-tauri/Cargo.toml", '[other]\nversion = "1.2.3"\n').ok, false);
  for (const duplicate of ['  version = "9.9.9"\n', '"version" = "9.9.9"\n', "'version' = '9.9.9'\n", '"vers\\u0069on" = "9.9.9"\n', 'version.foo = "9.9.9"\n']) {
    assert.equal(check("src-tauri/Cargo.toml", '[package]\nversion = "1.2.3"\n' + duplicate).ok, false);
    assert.equal(check("src-tauri/Cargo.lock", '[[package]]\nname = "multimedia-downloader"\nversion = "1.2.3"\n' + duplicate).ok, false);
  }
});

test("rejects unsupported paths, controls and version strings", () => {
  assert.equal(check("unknown", examples[0][1]).ok, false);
  assert.equal(check("engine/__init__.py", examples[1][1] + "\u2028").ok, false);
  assert.equal(classify("engine/__init__.py", examples[1][1], next(examples[1][1]), "01.2.3").ok, false);
});

