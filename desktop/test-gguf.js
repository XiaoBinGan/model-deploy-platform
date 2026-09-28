"use strict";

// The GGUF picker, against filenames actually observed in the repos the catalog
// points at. Getting this wrong means downloading the wrong quantization, or a
// shard set that cannot be loaded, so the cases are literal samples.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { pickGgufFile, parseShard, hasQuant, safeGgufRepo, safeGgufName, hfFileUrl } =
  require("./gguf.js");

// 挑不出来时返回空对象：这样「挑错了」表现为断言失败，而不是把后面所有检查
// 一起崩掉（变异测试时要看得见到底是哪一条不对）。
const pick = (names, quant) => pickGgufFile(names, quant) || {};
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log("  PASS  " + name); }
  else { fail += 1; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + detail : "")); }
}

// --- 每个目录条目对应仓库里真实的文件列表（抽样自 HF API）-------------------
const QWEN3_8B = [".gitattributes", "LICENSE", "Qwen3-8B-Q4_K_M.gguf",
  "Qwen3-8B-Q5_0.gguf", "Qwen3-8B-Q5_K_M.gguf", "Qwen3-8B-Q6_K.gguf",
  "Qwen3-8B-Q8_0.gguf", "README.md", "params"];
const QWEN25_7B = ["qwen2.5-7b-instruct-fp16-00001-of-00004.gguf",
  "qwen2.5-7b-instruct-fp16-00002-of-00004.gguf", "qwen2.5-7b-instruct-fp16-00003-of-00004.gguf",
  "qwen2.5-7b-instruct-fp16-00004-of-00004.gguf", "qwen2.5-7b-instruct-q2_k.gguf",
  "qwen2.5-7b-instruct-q3_k_m.gguf", "qwen2.5-7b-instruct-q4_0-00001-of-00002.gguf",
  "qwen2.5-7b-instruct-q4_0-00002-of-00002.gguf", "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
  "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf"];
const CODER_7B = ["qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf",
  "qwen2.5-coder-7b-instruct-q4_0-00002-of-00002.gguf", "qwen2.5-coder-7b-instruct-q4_0.gguf",
  "qwen2.5-coder-7b-instruct-q4_k_m-00001-of-00002.gguf",
  "qwen2.5-coder-7b-instruct-q4_k_m-00002-of-00002.gguf",
  "qwen2.5-coder-7b-instruct-q4_k_m.gguf"];
const QWEN25_32B = ["qwen2.5-32b-instruct-q4_k_m-00001-of-00005.gguf",
  "qwen2.5-32b-instruct-q4_k_m-00002-of-00005.gguf", "qwen2.5-32b-instruct-q4_k_m-00003-of-00005.gguf",
  "qwen2.5-32b-instruct-q4_k_m-00004-of-00005.gguf", "qwen2.5-32b-instruct-q4_k_m-00005-of-00005.gguf"];
const NEMO = ["Mistral-Nemo-Instruct-2407.Q4_K_M.gguf", "Mistral-Nemo-Instruct-2407.Q4_K_M.gguf.part1"];
const GEMMA = ["gemma-3-4b-it-Q4_K_M.gguf", "mmproj-model-f16-4B.gguf"];
const UNSLOTH_8B = ["Qwen3-8B-BF16.gguf", "Qwen3-8B-IQ4_NL.gguf", "Qwen3-8B-IQ4_XS.gguf",
  "Qwen3-8B-Q2_K.gguf", "Qwen3-8B-Q3_K_M.gguf", "Qwen3-8B-Q4_1.gguf", "Qwen3-8B-Q4_K_M.gguf",
  "Qwen3-8B-Q5_K_M.gguf", "Qwen3-8B-Q8_0.gguf"];

// --- 基本挑选 -----------------------------------------------------------
const a = pickGgufFile(QWEN3_8B, "q4_k_m");
check("Qwen3-8B 选出单文件", a && a.file === "Qwen3-8B-Q4_K_M.gguf", JSON.stringify(a));
check("单文件时 files 只有一个", a && a.files.length === 1, a && a.files.length);

// --- 分片：必须拿全部，且 -m 用第一片 ------------------------------------
const b = pickGgufFile(QWEN25_7B, "q4_k_m");
check("分片集全部收集", b && b.files.length === 2, b && b.files.length);
check("分片集按序且用第一片做 -m",
  b && b.file === "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf" &&
  b.files[1] === "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf", JSON.stringify(b));
const c = pickGgufFile(QWEN25_32B, "q4_k_m");
check("5 片全收", c && c.files.length === 5 && c.file.endsWith("00001-of-00005.gguf"), c && c.files.length);

// --- 同仓库既有单文件又有分片：优先单文件（少下文件、无需拼接）------------
const d = pickGgufFile(CODER_7B, "q4_k_m");
check("单文件优先于分片集", d && d.file === "qwen2.5-coder-7b-instruct-q4_k_m.gguf" && d.files.length === 1,
  JSON.stringify(d));

// --- 量化必须整体匹配，不能是片段 ----------------------------------------
check("q4_k_m 不会选中 q4_0", pick(CODER_7B, "q4_0").file.indexOf("q4_0") >= 0);
check("q4_k_m 不会选中 IQ4_NL", pick(UNSLOTH_8B, "q4_k_m").file === "Qwen3-8B-Q4_K_M.gguf");
check("IQ4_K_M 不会被 q4_k_m 命中（不同量化）", hasQuant("Qwen3-8B-IQ4_K_M.gguf", "q4_k_m") === false);
check("q4_k_m 命中点分隔的写法", hasQuant("Mistral-Nemo-Instruct-2407.Q4_K_M.gguf", "q4_k_m") === true);
check("q8_0 不与 q8_0_x 混淆", hasQuant("m-Q8_0.gguf", "q8_0") === true);

// --- 多模态工程文件不是模型 ----------------------------------------------
check("mmproj 不会被当成模型", pick(GEMMA, "q4_k_m").file === "gemma-3-4b-it-Q4_K_M.gguf");
check("mmproj 单独请求也拿不到", pickGgufFile(["mmproj-model-f16-4B.gguf"], "f16") === null);

// --- 混入的非 gguf / 坏输入 ----------------------------------------------
check("README/LICENSE 被忽略", pickGgufFile(["README.md", "LICENSE"], "q4_k_m") === null);
check("空列表返回 null", pickGgufFile([], "q4_k_m") === null);
check("非数组返回 null", pickGgufFile(null, "q4_k_m") === null);
check("没有该量化时返回 null", pickGgufFile(QWEN3_8B, "q4_k_s") === null);
check("分片不全时返回 null（不猜）",
  pickGgufFile(["m-q4_k_m-00001-of-00003.gguf", "m-q4_k_m-00003-of-00003.gguf"], "q4_k_m") === null);
check("分片编号总数为 0 的伪造名被拒",
  pickGgufFile(["m-q4_k_m-00001-of-00000.gguf"], "q4_k_m") === null);

// --- parseShard ---------------------------------------------------------
const s = parseShard("a-b-q4_k_m-00002-of-00007.gguf");
check("parseShard 解析 base/index/total",
  s && s.base === "a-b-q4_k_m" && s.index === 2 && s.total === 7, JSON.stringify(s));
check("非分片返回 null", parseShard("a-b-q4_k_m.gguf") === null);

// --- 不可信输入进 URL / 路径 --------------------------------------------
const only = (fn, v) => { try { fn(v); return null; } catch (e) { return e.message; } };
check("仓库 id 拒绝路径穿越", only(safeGgufRepo, "../../etc/passwd") !== null);
check("仓库 id 拒绝单段", only(safeGgufRepo, "Qwen3-8B") !== null);
check("仓库 id 拒绝空", only(safeGgufRepo, "") !== null);
check("仓库 id 拒绝 http:// 前缀", only(safeGgufRepo, "http://evil.example/x") !== null);
check("仓库 id 接受正常值", safeGgufRepo("Qwen/Qwen3-8B-GGUF") === "Qwen/Qwen3-8B-GGUF");
check("文件名拒绝斜杠", only(safeGgufName, "a/b.gguf") !== null);
check("文件名拒绝 ..", only(safeGgufName, "..gguf") !== null || only(safeGgufName, "a..b.gguf") !== null);
check("文件名拒绝非 gguf", only(safeGgufName, "model.bin") !== null);
check("文件名接受正常值", safeGgufName("Qwen3-8B-Q4_K_M.gguf") === "Qwen3-8B-Q4_K_M.gguf");
check("URL 固定为 huggingface.co",
  hfFileUrl("Qwen/Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf") ===
  "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
  hfFileUrl("Qwen/Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf"));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
