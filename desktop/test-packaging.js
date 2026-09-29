"use strict";

// Packaging regression test: the packaged app must contain the require() closure
// of its entry point, and must actually start.
//
// This exists because a hand-written `files:` whitelist in electron-builder.yml
// silently dropped ggufdl.js and gguf.js, while server.js:9 requires "./ggufdl"
// from the top-level require chain of main.js. The result on a real Windows box
// was a window titled "Error", no local HTTP service, and an installer that
// could be installed but never used. Nothing in the test suite noticed, because
// every other suite runs from the source tree, where all files are present.
//
// The check is derived, not enumerated: take the *.js files the config ships,
// walk their relative require() calls, and fail if one points outside the set.
// A new module is therefore covered the moment it is added.
//
//   node test-packaging.js            # static check (no build needed)
//   node test-packaging.js --built    # also launch dist/win-unpacked/ModelForge.exe
//
// The launch half only runs on Windows and only when a build already exists.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const here = __dirname;
const yml = fs.readFileSync(path.join(here, "electron-builder.yml"), "utf8");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
  if (ok) pass += 1;
  else fail += 1;
}

// --- read the `files:` list out of the real config -------------------------
const filesBlock = /^files:\r?\n((?:[ \t]+.*\r?\n)+)/m.exec(yml);
check("electron-builder.yml 有 files: 段", !!filesBlock);
const patterns = filesBlock
  ? filesBlock[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim().replace(/^["']|["']$/g, ""))
  : [];
console.log("        files: " + JSON.stringify(patterns));

// --- which desktop .js files those patterns select ------------------------
function selected(patterns, name) {
  let included = false;
  for (const p of patterns) {
    const negated = p.startsWith("!");
    const pat = negated ? p.slice(1) : p;
    const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
    if (re.test(name)) included = !negated;
  }
  return included;
}

const candidates = fs.readdirSync(here).filter((f) => f.endsWith(".js"));
const shipped = candidates.filter((f) => selected(patterns, f));
console.log("        进包的 .js: " + JSON.stringify(shipped));

check("入口 main.js 进包", shipped.indexOf("main.js") >= 0);
check("测试脚本不进包", shipped.every((f) => f !== "smoke.js" && !/^test-/.test(f)),
  shipped.filter((f) => f === "smoke.js" || /^test-/.test(f)).join(", "));

// --- walk the relative require() closure ----------------------------------
const REQUIRE = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
const seen = new Set();
const missing = [];
const queue = ["main.js"];
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  if (shipped.indexOf(file) < 0) continue;
  const src = fs.readFileSync(path.join(here, file), "utf8");
  let m;
  while ((m = REQUIRE.exec(src)) !== null) {
    const rel = m[1];
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), rel)) + ".js";
    if (shipped.indexOf(target) < 0) missing.push(file + " -> " + rel);
    else queue.push(target);
  }
  REQUIRE.lastIndex = 0;
}

check("入包的 require 闭包是封闭的（没有指向包外的相对 require）",
  missing.length === 0, missing.join(" | "));
check("闭包覆盖到 ggufdl.js / gguf.js（本次回归的具体形态）",
  shipped.indexOf("ggufdl.js") >= 0 && shipped.indexOf("gguf.js") >= 0);

// --- optionally launch the built app --------------------------------------
if (process.argv.indexOf("--built") >= 0) {
  const exe = path.join(here, "dist", "win-unpacked", "ModelForge.exe");
  if (process.platform !== "win32") {
    console.log("  SKIP  启动检查（非 win32）");
  } else if (!fs.existsSync(exe)) {
    console.log("  SKIP  启动检查（还没有 dist/win-unpacked，先 npm run dist）");
  } else {
    const port = 18813;
    const env = Object.assign({}, process.env, { MDP_PORT: String(port) });
    const child = spawnSync(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const c = spawn(${JSON.stringify(exe)}, [], { env: ${JSON.stringify(env)}, detached: true, stdio: "ignore" });
      c.unref();
      console.log(c.pid);
    `], { encoding: "utf8" });
    const pid = Number(String(child.stdout || "").trim());
    let healthy = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !healthy) {
      const probe = spawnSync("powershell", ["-NoProfile", "-Command",
        "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:" + port + "/api/health' -TimeoutSec 2 -UseBasicParsing).StatusCode } catch { 0 }"],
        { encoding: "utf8" });
      healthy = String(probe.stdout || "").trim() === "200";
      if (!healthy) spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 700"]);
    }
    check("打包后的 ModelForge.exe 能起本机 HTTP 服务", healthy,
      healthy ? "http://127.0.0.1:" + port + "/api/health = 200" : "30s 内不可达（这正是漏文件时的症状）");
    spawnSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='ModelForge.exe'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"]);
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
