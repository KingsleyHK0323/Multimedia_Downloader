// OpenAI-Codex_json_policy: strict, non-authorizing JSON release text classifier.
// No filesystem, network, token, branch, PR, tag or release operations are performed.

const ALLOWED = new Map([
  ["package.json", false], ["package-lock.json", true],
  ["frontend/package.json", false], ["frontend/package-lock.json", true],
  ["src-tauri/tauri.conf.json", false],
]);
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_LENGTH = 12_000_000;
const MAX_NODES = 600_000;
const MAX_DEPTH = 128;

// OpenAI-Codex_Fork_GitHub_REPO: reject lone UTF-16 surrogate code units.
function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

// Parse the complete JSON document while recording exact token offsets. Object
// keys are decoded before duplicate detection, including escaped spellings.
function parseDocument(text) {
  let pos = 0;
  let nodes = 0;
  const fail = () => { throw new Error("invalid, duplicate or unsupported JSON"); };
  const whitespace = () => { while (pos < text.length && /[ \t\r\n]/.test(text[pos])) pos++; };
  function stringToken() {
    const start = pos;
    if (text[pos++] !== '"') fail();
    while (pos < text.length) {
      const code = text.charCodeAt(pos);
      if (code < 0x20) fail();
      if (text[pos] === '"') {
        pos++;
        const raw = text.slice(start, pos);
        let value;
        try { value = JSON.parse(raw); } catch { fail(); }
        // Reject decoded lone surrogates in values and object keys.
        if (hasUnpairedSurrogate(value)) fail();
        return { type: "string", value, start, end: pos, raw };
      }
      if (text[pos] === "\\") {
        pos++;
        if (pos >= text.length) fail();
        if (text[pos] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(pos + 1, pos + 5))) fail();
          pos += 5;
        } else {
          if (!'"\\/bfnrt'.includes(text[pos])) fail();
          pos++;
        }
      } else pos++;
    }
    fail();
  }
  function value(depth) {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) fail();
    whitespace();
    if (text[pos] === '"') return stringToken();
    if (text[pos] === "{") {
      pos++;
      const entries = new Map();
      whitespace();
      if (text[pos] === "}") { pos++; return { type: "object", entries }; }
      while (pos < text.length) {
        whitespace();
        if (text[pos] !== '"') fail();
        const key = stringToken().value;
        if (entries.has(key)) fail();
        whitespace();
        if (text[pos++] !== ":") fail();
        const entry = value(depth + 1);
        entries.set(key, entry);
        whitespace();
        if (text[pos] === "}") { pos++; return { type: "object", entries }; }
        if (text[pos++] !== ",") fail();
      }
      fail();
    }
    if (text[pos] === "[") {
      pos++;
      whitespace();
      if (text[pos] === "]") { pos++; return { type: "array" }; }
      while (pos < text.length) {
        value(depth + 1);
        whitespace();
        if (text[pos] === "]") { pos++; return { type: "array" }; }
        if (text[pos++] !== ",") fail();
      }
      fail();
    }
    const rest = text.slice(pos);
    const literal = /^(?:true|false|null)/.exec(rest);
    if (literal) { pos += literal[0].length; return { type: "literal" }; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    // JSON permits large exponents, but downstream JavaScript consumers may
    // otherwise interpret them as Infinity. Treat that case as unsupported.
    if (number) {
      if (!Number.isFinite(Number(number[0]))) fail();
      pos += number[0].length;
      return { type: "number" };
    }
    fail();
  }
  const result = value(0);
  whitespace();
  if (pos !== text.length) fail();
  return result;
}

function getObjectEntry(node, key) {
  if (node?.type !== "object") throw new Error("object expected");
  const value = node.entries.get(key);
  if (!value) throw new Error("required field missing");
  return value;
}

export function classifyReleaseJsonVersionText(path, before, after, previousVersion) {
  const reject = (reason) => ({ ok: false, reason, completeRelease: false, mergeAuthorized: false });
  if (!ALLOWED.has(path) || typeof before !== "string" || typeof after !== "string" ||
      before.length > MAX_LENGTH || after.length > MAX_LENGTH || typeof previousVersion !== "string" ||
      previousVersion.length > 50) return reject("unsupported input");
  const match = VERSION.exec(previousVersion);
  if (!match) return reject("invalid version");
  const nextVersion = `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`;
  try {
    const oldRoot = parseDocument(before);
    const newRoot = parseDocument(after);
    const select = (root) => {
      const fields = [getObjectEntry(root, "version")];
      if (ALLOWED.get(path)) {
        const packages = getObjectEntry(root, "packages");
        const rootPackage = getObjectEntry(packages, "");
        fields.push(getObjectEntry(rootPackage, "version"));
      }
      return fields;
    };
    const oldFields = select(oldRoot);
    const newFields = select(newRoot);
    if (oldFields.some((item) => item.type !== "string" || item.value !== previousVersion ||
        item.raw !== JSON.stringify(previousVersion)) ||
        newFields.some((item) => item.type !== "string" || item.value !== nextVersion ||
        item.raw !== JSON.stringify(nextVersion))) return reject("version field mismatch");
    let expected = before;
    for (const field of [...oldFields].sort((a, b) => b.start - a.start)) {
      expected = expected.slice(0, field.start) + JSON.stringify(nextVersion) + expected.slice(field.end);
    }
    if (after !== expected) return reject("unexpected text change");
    return { ok: true, path, previousVersion, nextVersion, completeRelease: false, mergeAuthorized: false };
  } catch {
    return reject("invalid, duplicate or unsupported JSON");
  }
}

