"use strict";

// Exercises the MLX backend without mlx-lm installed, by putting a fake
// "python3" on PATH that answers "import mlx_lm" and then serves /health.
// MLX is the only high-throughput local path on Apple Silicon, so it needs a
// test that runs on any machine that has the platform, not the package.

const { execFileSync } = require("node:child_process");
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
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake-mlx" }] }));
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
    'if [ "$1" = "-c" ]; then',
    '  case "$2" in',
    "    *mlx_lm*) exit 0 ;;",
    "    *) exit 1 ;;",
    "  esac",
    "fi",
    'if [ "$1" = "-m" ] && [ "$2" = "mlx_lm.server" ]; then',
    "  shift 2",
    "  exec /usr/bin/env node " + path.join(dir, "fake_mlx_server.js") + ' "$@"',
    "fi",
    "exit 1",
    "",
  ].join("\n"));
  fs.chmodSync(shim, 0o755);
  return bin;
}

(async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.log("  SKIP  MLX 只在 Apple Silicon 上可用（本机 " +
      process.platform + "/" + process.arch + "）");
    process.exit(0);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-mlx-"));
  const dataDir = path.join(dir, "data");
  const argsFile = path.join(dir, "args.json");
  process.env.MLX_ARGS_FILE = argsFile;
  process.env.PATH = buildFakePython(dir) + path.delimiter + process.env.PATH;

  try {
    const d = new Deployments(dataDir, "");

    const be = await d.detectBackends();
    check("detectBackends 报告 mlx", be.backends.indexOf("mlx") >= 0,
      JSON.stringify(be.backends));

    const item = d.create({
      backend: "mlx",
      model_path: "mlx-community/Qwen3-8B-4bit",
      port: 8931,
    });
    check("create 保留指定端口", item.port === 8931, "port=" + item.port);
    check("health_endpoint 指向 /health", item.health_endpoint.endsWith("/health"),
      item.health_endpoint);

    d.start(item.id);
    const done = await waitSettled(d, item.id, 30);
    check("mlx 启动到 RUNNING", done.status === "RUNNING",
      done.status + " | " + (done.log || []).slice(-1)[0]);

    const used = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    check("--model 传的是 HF 仓库 id",
      used[used.indexOf("--model") + 1] === "mlx-community/Qwen3-8B-4bit", used.join(" "));
    check("传了 --kv-bits 8（对应项目的 q8_0 KV 量化）",
      used[used.indexOf("--kv-bits") + 1] === "8", used.join(" "));
    check("host 绑到回环", used[used.indexOf("--host") + 1] === "127.0.0.1");

    const h = await d.health(item.id);
    check("health 返回 200", h.healthy === true, "healthy=" + h.healthy);

    // The system Python is usually PEP 668 managed, so mlx-lm lives in a venv.
    // Detection must reach it even when it is not on PATH.
    process.env.MDP_MLX_PYTHON = path.join(dir, "bin", "python3");
    process.env.PATH = "/usr/bin:/bin";
    const be2 = await d.detectBackends();
    check("MDP_MLX_PYTHON 指向的 venv 也能被找到",
      be2.backends.indexOf("mlx") >= 0, JSON.stringify(be2.backends));

    const pid = done.pid;
    await d.stop(item.id);
    await sleep(800);
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { alive = false; }
    check("stop 之后子进程确实不存在", alive === false, "pid=" + pid);
    check("procs 已清空", d.procs.size === 0, "size=" + d.procs.size);

    console.log("\n" + pass + " passed, " + fail + " failed");
    process.exit(fail ? 1 : 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
