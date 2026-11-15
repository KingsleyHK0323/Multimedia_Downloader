// OpenAI-Codex_release_validator: narrow, non-authorizing release text check.
// This does not inspect a full release, authorize writes, or approve a merge.

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const ALLOWED = new Set([
  "README.md", "engine/__init__.py", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyReleaseVersionText(path, before, after, previousVersion) {
  if (!ALLOWED.has(path) || typeof before !== "string" || typeof after !== "string" ||
      typeof previousVersion !== "string" || before.length > 2_000_000 || after.length > 2_000_000 ||
      before.includes("\r") || after.includes("\r") || before.includes("\0") || after.includes("\0")) {
    return { ok: false, reason: "unsupported input" };
  }
  // OpenAI-Codex_Fork_GitHub_REPO: regex line boundaries must not admit hidden separators.
  const unsupportedControl = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/;
  if (unsupportedControl.test(before) || unsupportedControl.test(after)) {
    return { ok: false, reason: "unsupported control or line separator" };
  }
  const parsed = VERSION.exec(previousVersion);
  if (!parsed || previousVersion.length > 50) return { ok: false, reason: "invalid version" };
  const nextVersion = `${parsed[1]}.${parsed[2]}.${BigInt(parsed[3]) + 1n}`;
  const old = escapeRegExp(previousVersion);
  let expression;
  if (path === "README.md") expression = new RegExp(`^(# Multimedia Downloader — V)${old}$`, "gm");
  if (path === "engine/__init__.py") expression = new RegExp(`^(__version__\\s*=\\s*")${old}("$)`, "gm");
  if (path === "src-tauri/Cargo.toml") expression = new RegExp(`^(version\\s*=\\s*")${old}("$)`, "gm");
  if (path === "src-tauri/Cargo.lock") expression = new RegExp(`(^name = "multimedia-downloader"\\nversion = ")${old}("$)`, "gm");
  const matches = [...before.matchAll(expression)];
  if (matches.length !== 1) return { ok: false, reason: "ambiguous version location" };
  const match = matches[0];
  // OpenAI-Codex_Fork_GitHub_REPO: ambiguous multiline source text is unsupported.
  if (path !== "README.md" && (before.includes('"""') || before.includes("'''"))) {
    return { ok: false, reason: "multiline string requires semantic parsing" };
  }
  if (path === "README.md" && match.index !== 0) {
    return { ok: false, reason: "version heading is not the first line" };
  }
  if (path === "src-tauri/Cargo.lock") {
    const headers = [...before.matchAll(/^\[\[package\]\][ \t]*$/gm)];
    const prior = headers.filter((header) => header.index < match.index).at(-1);
    if (!prior || before.slice(prior.index + prior[0].length, match.index).trim() !== "") {
      return { ok: false, reason: "lockfile version is outside the package header" };
    }
  }
  // OpenAI-Codex_Fork_GitHub_REPO: never treat multiline whitespace as a version field.
  if (path !== "src-tauri/Cargo.lock" && match[0].includes("\n")) {
    return { ok: false, reason: "multiline version field" };
  }
  if (path === "src-tauri/Cargo.toml") {
    const headers = [...before.matchAll(/^[ \t]*\[([^\]\n]+)\][ \t]*(?:#.*)?$/gm)];
    const prior = headers.filter((header) => header.index < match.index);
    if (headers.filter((header) => header[1] === "package").length !== 1 ||
        prior.at(-1)?.[1] !== "package") {
      return { ok: false, reason: "version is outside the unique package section" };
    }
  }
  // OpenAI-Codex_Fork_GitHub_REPO: other version declarations are ambiguous.
  if (path === "engine/__init__.py" && [...before.matchAll(/^__version__[ \t]*=/gm)].length !== 1) {
    return { ok: false, reason: "ambiguous engine version declaration" };
  }
  if (path === "src-tauri/Cargo.lock" && [...before.matchAll(/^name = "multimedia-downloader"$/gm)].length !== 1) {
    return { ok: false, reason: "ambiguous lockfile package" };
  }
  if (path === "src-tauri/Cargo.toml") {
    const header = [...before.matchAll(/^[ \t]*\[([^\]\n]+)\][ \t]*(?:#.*)?$/gm)];
    const packageHeader = header.find((entry) => entry[1] === "package");
    const next = header.find((entry) => entry.index > packageHeader.index);
    const section = before.slice(packageHeader.index, next?.index ?? before.length);
    if ([...section.matchAll(/^version[ \t]*=/gm)].length !== 1) {
      return { ok: false, reason: "ambiguous package version declaration" };
    }
  }
  // OpenAI-Codex_Fork_GitHub_REPO: typed or augmented assignments remain ambiguous.
  if (path === "engine/__init__.py" && [...before.matchAll(/^__version__(?=[ \t:=+*\/%-])/gm)].length !== 1) {
    return { ok: false, reason: "ambiguous engine assignment" };
  }
  if (path === "src-tauri/Cargo.lock") {
    const headers = [...before.matchAll(/^\[\[package\]\][ \t]*$/gm)];
    const prior = headers.filter((header) => header.index < match.index).at(-1);
    const next = headers.find((header) => header.index > prior.index);
    const section = before.slice(prior.index, next?.index ?? before.length);
    if ([...section.matchAll(/^version[ \t]*=/gm)].length !== 1) {
      return { ok: false, reason: "ambiguous lockfile version declaration" };
    }
  }
  const replacement = `${match[1]}${nextVersion}${match[2] ?? ""}`;
  const expected = before.slice(0, match.index) + replacement + before.slice(match.index + match[0].length);
  if (after !== expected) return { ok: false, reason: "unexpected text change" };
  return { ok: true, path, previousVersion, nextVersion, completeRelease: false, mergeAuthorized: false };
}