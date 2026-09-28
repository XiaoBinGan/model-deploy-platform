"use strict";

// Resolving a catalog model to one GGUF file (or one shard set) on HuggingFace.

// Everything here is pure: it takes the file list the HF API returned and picks
// from it. That matters because the list is *untrusted input* - it is whatever
// the network said - and the picked name goes into a URL and a file path.

// Real filenames this has to cope with, all observed in the repos the catalog
// actually points at:
//
//   qwen2.5-0.5b-instruct-q4_k_m.gguf          lowercase
//   Llama-3.2-1B-Instruct-Q4_K_M.gguf          uppercase
//   Mistral-Nemo-Instruct-2407.Q4_K_M.gguf     dot separator
//   Qwen3-8B-Q4_K_M.gguf                       hyphen separator
//   qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf   sharded
//   qwen2.5-coder-7b-instruct-q4_k_m.gguf      ...and the same repo ALSO has
//   qwen2.5-coder-7b-instruct-q4_k_m-00001-of-00002.gguf  a 2-shard set
//
// The last case is why a plain file wins over a shard set: fewer files to fetch,
// nothing to reassemble, and llama.cpp needs only the first shard either way.

const SHARD = /^(.*)-\d{5}-of-\d{5}\.gguf$/i;

function isGguf(name) {
  return typeof name === "string" && /\.gguf$/i.test(name);
}

// The quant has to be a whole token, not a fragment. `q4_0` must not match when
// q4_k_m was asked for, and `IQ4_K_M` must not match `q4_k_m` - it is a different
// quantization, not the same one written differently. So the character before and
// after the match must not be alphanumeric.
function hasQuant(name, quant) {
  const hay = String(name).toLowerCase();
  const needle = String(quant).toLowerCase();
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : hay[at - 1];
    const after = hay[at + needle.length] || "";
    const alnum = (c) => c !== "" && /[a-z0-9]/.test(c);
    if (!alnum(before) && !alnum(after)) return true;
    from = at + 1;
  }
}

// A multimodal projector is a .gguf too, but it is not the model. Loading it as
// the model fails in a confusing way, so it is never a candidate.
function isProjector(name) {
  return /mmproj/i.test(String(name));
}

function parseShard(name) {
  const m = SHARD.exec(String(name));
  if (!m) return null;
  const parts = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(String(name));
  // `name` is kept verbatim: rebuilding it would have to reproduce the original
  // case and separators exactly, and it is already right there.
  return { base: m[1], index: Number(parts[1]), total: Number(parts[2]), name: String(name) };
}

// Returns { file, files } - `file` is what llama.cpp gets via -m, `files` is
// everything that must be on disk first. Returns null when the repo has nothing
// matching, which the caller must surface rather than guess around.
function pickGgufFile(names, quant) {
  const all = (Array.isArray(names) ? names : []).filter(
    (n) => isGguf(n) && !isProjector(n) && hasQuant(n, quant));
  if (!all.length) return null;

  const plain = all.filter((n) => !parseShard(n)).sort();
  if (plain.length) return { file: plain[0], files: [plain[0]] };

  // No single file: every candidate is part of a shard set. Group by base and
  // take the lexicographically first group so the choice is deterministic.
  const groups = new Map();
  for (const n of all) {
    const s = parseShard(n);
    // `all` only reaches here when no plain file matched, so every entry ought
    // to be a shard - but this loop must not depend on that. A crash here would
    // take down a download that is otherwise perfectly fine.
    if (!s) continue;
    if (!groups.has(s.base)) groups.set(s.base, []);
    groups.get(s.base).push(s);
  }
  for (const base of [...groups.keys()].sort()) {
    const parts = groups.get(base).sort((a, b) => a.index - b.index);
    const total = parts[0].total;
    const seen = parts.map((p) => p.index);
    const complete =
      parts.length === total &&
      parts.every((p) => p.total === total) &&
      seen.every((v, i) => v === i + 1);
    if (!complete) continue;
    const files = parts.map((p) => p.name);
    return { file: files[0], files };
  }
  return null;
}

// A repo id goes into a URL, so it is limited to the shape HF actually uses.
function safeGgufRepo(repo) {
  const s = String(repo == null ? "" : repo);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) {
    throw new Error("不是合法的 HuggingFace 仓库 id：" + JSON.stringify(s));
  }
  return s;
}

// A filename from the network becomes a path component and a URL segment. Reject
// anything that is not a single .gguf basename, so `..` and nested paths cannot
// be expressed at all.
function safeGgufName(name) {
  const s = String(name == null ? "" : name);
  if (s.indexOf("/") >= 0 || s.indexOf("\\") >= 0 || s.indexOf("..") >= 0) {
    throw new Error("不是合法的 GGUF 文件名：" + JSON.stringify(s));
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/i.test(s)) {
    throw new Error("不是合法的 GGUF 文件名：" + JSON.stringify(s));
  }
  return s;
}

const HF_HOST = "https://huggingface.co";

function hfFileUrl(repo, name) {
  return HF_HOST + "/" + safeGgufRepo(repo).split("/").map(encodeURIComponent).join("/") +
    "/resolve/main/" + encodeURIComponent(safeGgufName(name));
}

module.exports = {
  pickGgufFile, parseShard, hasQuant, isGguf, isProjector,
  safeGgufRepo, safeGgufName, hfFileUrl, HF_HOST,
};
