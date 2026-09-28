"use strict";

// Fetching a GGUF from HuggingFace. The pure half - which file to pick, and what
// counts as a legal repo id or filename - lives in gguf.js; this half touches the
// network and the disk.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const { pickGgufFile, safeGgufRepo, safeGgufName, hfFileUrl } = require("./gguf");

// One directory per repo: a sharded model is several files and llama.cpp finds
// the rest from the first one, so they must stay together.
function ggufRoot() {
  return process.env.MDP_GGUF_DIR || path.join(os.homedir(), ".mdp-models");
}

function repoDir(repo) {
  return path.join(ggufRoot(), safeGgufRepo(repo).replace("/", "--"));
}

function localPath(repo, name) {
  return path.join(repoDir(repo), safeGgufName(name));
}

// Gated repos need a token. Passing one through when the user has set HF_TOKEN
// is the difference between llama/gemma working and a bare 401.
function authHeaders() {
  const t = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  return t ? { authorization: "Bearer " + t } : {};
}

async function listGgufFiles(repo) {
  const url = "https://huggingface.co/api/models/" +
    safeGgufRepo(repo).split("/").map(encodeURIComponent).join("/");
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error("查询 " + repo + " 失败：HTTP " + res.status +
      (res.status === 401 || res.status === 403
        ? "（仓库不存在或需要授权；门控仓库请设 HF_TOKEN）" : ""));
  }
  const data = await res.json();
  return (data.siblings || []).map((s) => s.rfilename).filter(Boolean);
}

async function headSize(url) {
  try {
    const res = await fetch(url, { method: "HEAD", headers: authHeaders(),
      redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!res.ok) return 0;
    return Number(res.headers.get("content-length")) || 0;
  } catch (e) { return 0; }
}

// What would be downloaded, without downloading it. The caller shows this to the
// user before anything is fetched.
async function plan(repo, quant) {
  const names = await listGgufFiles(repo);
  const picked = pickGgufFile(names, quant);
  if (!picked) {
    throw new Error("仓库 " + repo + " 里没有 " + quant + " 的 GGUF 文件" +
      "（该仓库共 " + names.filter((n) => /\.gguf$/i.test(n)).length + " 个 gguf）。");
  }
  const files = [];
  let bytes = 0;
  for (const name of picked.files) {
    const url = hfFileUrl(repo, name);
    const dest = localPath(repo, name);
    const size = await headSize(url);
    const have = fileSize(dest);
    bytes += size;
    files.push({ name, url, dest, size, have, done: have > 0 && size > 0 && have === size });
  }
  const first = files[0];
  return {
    repo, quant, files, bytes,
    // -m gets the first shard; llama.cpp loads the rest by itself.
    model_path: first.dest,
    needs_download: files.some((f) => !f.done),
    missing_bytes: files.reduce((n, f) => n + (f.done ? 0 : Math.max(0, f.size - f.have)), 0),
  };
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

// Resumable: an interrupted 20 GB download must not start over. `.part` is
// appended to with a Range request when the server told us the total.
async function downloadOne(url, dest, onProgress, isCancelled) {
  const part = dest + ".part";
  let have = fileSize(part);
  const headers = Object.assign({}, authHeaders());
  if (have > 0) headers.range = "bytes=" + have + "-";

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) {
    if (res.status === 416) { fs.renameSync(part, dest); return have; }
    throw new Error("下载失败 HTTP " + res.status + "：" + url);
  }
  // A server that ignored the Range answers 200 with the whole body, so the
  // partial file must be discarded rather than appended to.
  if (have > 0 && res.status !== 206) have = 0;
  const total = have + (Number(res.headers.get("content-length")) || 0);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(part, have > 0 ? { flags: "a" } : { flags: "w" });
  let got = have;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (onProgress) onProgress(got, total);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, out);
  } catch (e) {
    throw new Error("下载中断（已保留可续传的 .part）：" + ((e && e.message) || e));
  }
  if (isCancelled && isCancelled()) throw new Error("已取消");
  if (total > 0 && fileSize(part) !== total) {
    throw new Error("下载不完整：" + fileSize(part) + " / " + total + " 字节");
  }
  fs.renameSync(part, dest);
  return fileSize(dest);
}

// Runs the whole plan. `onEvent` receives plain objects so the caller can turn
// them into SSE frames without this module knowing about HTTP.
async function download(repo, quant, onEvent, isCancelled) {
  const p = await plan(repo, quant);
  onEvent({ type: "plan", bytes: p.bytes, files: p.files.map((f) => f.name),
    model_path: p.model_path, needs_download: p.needs_download });
  let doneBytes = 0;
  const already = p.files.reduce((n, f) => n + (f.done ? f.size : 0), 0);
  for (const f of p.files) {
    if (isCancelled && isCancelled()) throw new Error("已取消");
    if (f.done) { onEvent({ type: "skip", file: f.name }); continue; }
    onEvent({ type: "file", file: f.name, size: f.size });
    const base = doneBytes;
    await downloadOne(f.url, f.dest, (got, total) => {
      onEvent({ type: "progress", file: f.name, got, total,
        overall_got: already + base + got, overall_total: p.bytes });
    }, isCancelled);
    doneBytes += f.size;
    onEvent({ type: "file-done", file: f.name });
  }
  return p;
}

module.exports = { ggufRoot, repoDir, localPath, listGgufFiles, plan, download, downloadOne };
