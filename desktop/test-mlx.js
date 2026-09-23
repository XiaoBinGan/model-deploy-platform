"use strict";

// Exercises the MLX backend without mlx-lm installed, by putting a fake
// "python3" on PATH that answers "import mlx_lm", reports a configurable
// --help, and then serves /health.
//
// The fake --help matters: mlx-lm only grew --kv-bits after the released
// 0.31.3, and passing it to an older build aborts startup with exit code 2.
// So this test drives both versions and checks the flag is only sent when the
// installed build advertises it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Deployments } = require("./deploy.js");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
  if (ok) pass += 1;
  else fail += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSettled(d, id, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const item = d.get(id);
    if (item.status !== "STARTING") return item;
    await sleep(500);
  }
  return d.get(id);
}

function buildFakePython(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, "fake_mlx_server.js"), `
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.MLX_ARGS_FILE, JSON.stringify(args));
const port = Number(args[args.indexOf("--port") + 1]);
// Mirrors mlx_lm.server: the port is bound before the weights exist, so
// /health answers immediately while the first completion waits for the load.
const loadMs = Number(process.env.MLX_LOAD_MS || 0);
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake-mlx" }] }));
    return;
  }
  if (req.url === "/v1/chat/completions") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    }, loadMs);
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
`);
  const shim = path.join(bin, "python3");
  fs.writeFileSync(shim, [
    "#!/bin/sh",
    'case "$1" in',
    "  -c)",
    '    case "$2" in',
    "      *mlx_lm*) exit 0 ;;",
    "      *) exit 1 ;;",
    "    esac ;;",
    "  -m)",
    '    [ "$2" = "mlx_lm" ] || exit 1',
    '    [ "$3" = "server" ] || exit 1',
    "    shift 2",
    '    for a in "$@"; do',
    '      if [ "$a" = "--help" ]; then cat "$MLX_HELP_FILE"; exit 0; fi',
    "    done",
    "    exec /usr/bin/env node " + path.join(dir, "fake_mlx_server.js") + ' "$@" ;;',
    "esac",
    "exit 1",
    "",
  ].join("\n"));
  fs.chmodSync(shim, 0o755);
  return bin;
}

// Run the whole lifecycle against one fake mlx-lm "version".
async function runCase(dir, helpText, label, loadMs) {
  const helpFile = path.join(dir, "help-" + label + ".txt");
  fs.writeFileSync(helpFile, helpText);
  process.env.MLX_HELP_FILE = helpFile;
  process.env.MLX_ARGS_FILE = path.join(dir, "args-" + label + ".json");
  process.env.MLX_LOAD_MS = String(loadMs || 0);

  const d = new Deployments(path.join(dir, "data-" + label), "");
  const item = d.create({
    backend: "mlx",
    model_path: "mlx-community/Qwen3-8B-4bit",
    port: 8931,
  });
  const t0 = Date.now();
  d.start(item.id);
  const done = await waitSettled(d, item.id, 60);
  const elapsed = Date.now() - t0;
  // Capture everything before stopping: stop() mutates the same object, so
  // reading status afterwards always reports STOPPED.
  const status = done.status;
  const log = (done.log || []).slice();
  const used = JSON.parse(fs.readFileSync(process.env.MLX_ARGS_FILE, "utf8"));
  const healthy = (await d.health(item.id)).healthy;
  const pid = done.pid;
  await d.stop(item.id);
  await sleep(700);
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { alive = false; }
  return { d, item, status, log, used, alive, healthy, elapsed };
}

(async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.log("  SKIP  MLX 只在 Apple Silicon 上可用（本机 " +
      process.platform + "/" + process.arch + "）");
    process.exit(0);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-mlx-"));
  process.env.PATH = buildFakePython(dir) + path.delimiter + process.env.PATH;

  try {
    // --- case A: an older mlx-lm, without --kv-bits (this is 0.31.3 today) ---
    const noKv = "  --model MODEL\n  --host HOST\n  --port PORT\n";
    const a = await runCase(dir, noKv, "nokv");
    check("老版本 mlx-lm：不传 --kv-bits",
      a.used.indexOf("--kv-bits") < 0, a.used.join(" "));
    check("老版本 mlx-lm：仍然启动到 RUNNING", a.status === "RUNNING",
      a.status + " | " + a.log.slice(-1)[0]);
    check("老版本：日志说明了 KV 走全精度",
      a.log.some((l) => l.indexOf("--kv-bits") >= 0), a.log.slice(-1)[0]);
    check("用的是非废弃的调用形式 -m mlx_lm server",
      a.used[0] === "server", a.used.join(" "));

    // --- case B: a newer mlx-lm that advertises --kv-bits ---
    const withKv = "  --model MODEL\n  --kv-bits KV_BITS\n  --port PORT\n";
    const b = await runCase(dir, withKv, "kv");
    check("新版本 mlx-lm：传 --kv-bits 8",
      b.used[b.used.indexOf("--kv-bits") + 1] === "8", b.used.join(" "));
    check("新版本 mlx-lm：启动到 RUNNING", b.status === "RUNNING",
      b.status + " | " + b.log.slice(-1)[0]);

    // --- case C: weights load slowly, as they do on a real first run ---
    const c = await runCase(dir, withKv, "slow", 6000);
    check("权重加载慢时仍能到 RUNNING", c.status === "RUNNING",
      c.status + " | " + c.log.slice(-1)[0]);
    check("RUNNING 出现在权重加载之后，不是 /health 一通过就报",
      c.elapsed >= 6000, "耗时 " + c.elapsed + "ms（权重加载 6000ms）");
    check("日志说明了先监听、后加载",
      c.log.some((l) => l.indexOf("正在加载权重") >= 0),
      c.log.filter((l) => l.indexOf("加载") >= 0).slice(-1)[0] || "(无)");

    // --- shared assertions on the last case ---
    check("--model 传的是 HF 仓库 id",
      b.used[b.used.indexOf("--model") + 1] === "mlx-community/Qwen3-8B-4bit",
      b.used.join(" "));
    check("host 绑到回环", b.used[b.used.indexOf("--host") + 1] === "127.0.0.1");

    check("health 返回 200（两个版本都查）", a.healthy === true && b.healthy === true,
      "a=" + a.healthy + " b=" + b.healthy);

    check("stop 之后子进程确实不存在", a.alive === false && b.alive === false,
      "a=" + a.alive + " b=" + b.alive);
    check("procs 已清空", b.d.procs.size === 0, "size=" + b.d.procs.size);

    // Detection must reach a venv, which is where mlx-lm actually lands because
    // the system Python is usually PEP 668 managed.
    process.env.MDP_MLX_PYTHON = path.join(dir, "bin", "python3");
    process.env.PATH = "/usr/bin:/bin";
    const be = await new Deployments(path.join(dir, "data-detect"), "").detectBackends();
    check("MDP_MLX_PYTHON 指向的 venv 也能被找到",
      be.backends.indexOf("mlx") >= 0, JSON.stringify(be.backends));

    console.log("\n" + pass + " passed, " + fail + " failed");
    process.exit(fail ? 1 : 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
