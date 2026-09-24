"use strict";

// Exercises the Docker backend without Docker installed, by putting a fake
// "docker" on PATH. The fake answers "docker info", records "rm -f", serves a
// real /health (or only /v1/models in one case), and stays alive.
//
// It also simulates the docs/docker-design.md 4.1 hazard: when the "docker run"
// process is killed, the "container" stays in its state file until "docker rm
// -f" removes it. That lets the test prove stop()/delete() do not leave a
// zombie container holding the host port.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { Deployments, safePort, hasBinary } = require("./deploy.js");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
  if (ok) pass += 1;
  else fail += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

async function waitSettled(d, id, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const item = d.get(id);
    if (item.status !== "STARTING") return item;
    await sleep(500);
  }
  return d.get(id);
}

function buildFakeDocker(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const lines = [
    '"use strict";',
    'const http = require("node:http");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    '',
    'function record(call) {',
    '  const file = process.env.DOCKER_CALLS_FILE;',
    '  if (!file) return;',
    '  let list = [];',
    '  try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}',
    '  list.push(call);',
    '  fs.writeFileSync(file, JSON.stringify(list));',
    '}',
    'function state() {',
    '  try { return JSON.parse(fs.readFileSync(process.env.DOCKER_STATE_FILE, "utf8")); }',
    '  catch (e) { return []; }',
    '}',
    'function setState(list) {',
    '  fs.writeFileSync(process.env.DOCKER_STATE_FILE, JSON.stringify(list));',
    '}',
    '',
    'if (args[0] === "info") {',
    '  process.stdout.write("25.0.0");',
    '  process.exit(0);',
    '}',
    'if (args[0] === "rm") {',
    '  record(["rm"].concat(args.slice(1)));',
    '  const name = args[args.length - 1];',
    '  setState(state().filter(function (n) { return n !== name; }));',
    '  if (process.env.DOCKER_RM_FAIL === "1") {',
    '    process.stderr.write("Error response from daemon: conflict: unable to remove container");',
    '    process.exit(1);',
    '  }',
    '  process.exit(0);',
    '}',
    'if (args[0] === "run") {',
    '  record(["run"].concat(args.slice(1)));',
    '  fs.writeFileSync(process.env.DOCKER_ARGS_FILE, JSON.stringify(args));',
    '  const name = args[args.indexOf("--name") + 1];',
    '  setState(state().concat([name]));',
    '  let port = 0;',
    '  const pi = args.indexOf("-p");',
    '  if (pi >= 0) port = Number(args[pi + 1].split(":")[1]);',
    '  const mode = process.env.DOCKER_HEALTH_MODE || "200";',
    '  const server = http.createServer(function (req, res) {',
    '    if (req.url === "/health") {',
    '      if (mode === "404") { res.writeHead(404); res.end(); return; }',
    '      res.writeHead(200); res.end("ok"); return;',
    '    }',
    '    if (req.url === "/v1/models") {',
    '      res.writeHead(200, { "content-type": "application/json" });',
    '      res.end(JSON.stringify({ object: "list", data: [] }));',
    '      return;',
    '    }',
    '    res.writeHead(404); res.end();',
    '  });',
    '  server.listen(port, "127.0.0.1");',
    '  // Leave the name in the state file on SIGTERM: that is the zombie',
    '  // container the lifecycle code must clean up with docker rm -f.',
    '  process.on("SIGTERM", function () { process.exit(0); });',
    '  return;',
    '}',
    'process.exit(2);',
    '',
  ];
  fs.writeFileSync(path.join(dir, "fake_docker.js"), lines.join(NL));
  const shim = path.join(bin, "docker");
  fs.writeFileSync(shim, [
    "#!/bin/sh",
    "exec /usr/bin/env node " + path.join(dir, "fake_docker.js") + ' "$@"',
    "",
  ].join(NL));
  fs.chmodSync(shim, 0o755);
  return bin;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-docker-"));
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const fakeHome = path.join(dir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  const fakeBin = buildFakeDocker(dir);
  process.env.PATH = fakeBin + path.delimiter + savedPath;

  try {
    const d = new Deployments(path.join(dir, "data"), "");
    const volDir = fs.mkdtempSync(path.join(dir, "vol-"));
    const volDir2 = fs.mkdtempSync(path.join(dir, "vol2-"));

    // --- _dockerArgv shape (pure, no Docker needed) ------------------------
    function mk(over) {
      return d.create(Object.assign({
        backend: "docker",
        model_path: "Qwen/Qwen3-8B",
        port: 18080,
      }, over || {}));
    }

    const a = mk({});
    check("默认镜像 vllm/vllm-openai:latest", a.image === "vllm/vllm-openai:latest", a.image);
    check("默认 gpus=all", a.gpus === "all", a.gpus);
    check("默认 container_port=8000（vllm）", a.container_port === 8000, String(a.container_port));
    check("默认 volumes/extra_args 为空", a.volumes.length === 0 && a.extra_args.length === 0);
    check("空 image 也用默认", mk({ image: "" }).image === "vllm/vllm-openai:latest");
    check("hf_cache 是 HOME 下的 .cache/huggingface",
      a.hf_cache === path.join(fakeHome, ".cache", "huggingface"), a.hf_cache);
    check("_dockerArgv 之前 hf_cache 目录已创建", fs.existsSync(a.hf_cache), a.hf_cache);

    const expA = [
      "docker", "run", "--rm", "--name", "mdp-" + a.id,
      "-p", "127.0.0.1:18080:8000", "--gpus", "all",
      "-e", "HF_HOME=/hf",
      "-v", a.hf_cache + ":/hf",
      "vllm/vllm-openai:latest",
      "--model", "Qwen/Qwen3-8B", "--host", "0.0.0.0",
      "--port", "8000", "--max-model-len", "65536",
    ];
    const argvA = d._dockerArgv(a, 65536);
    check("默认 argv 完整形状", JSON.stringify(argvA) === JSON.stringify(expA), argvA.join(" "));
    check("argv 始终挂载 hf_cache", argvA.indexOf(a.hf_cache + ":/hf") >= 0, argvA.join(" "));

    const none = d._dockerArgv(mk({ gpus: "none" }), 65536);
    check("gpus=none 时整条 --gpus 省略", none.indexOf("--gpus") < 0, none.join(" "));
    check("gpus=0,1 被接受", mk({ gpus: "0,1" }).gpus === "0,1");

    const vols = d._dockerArgv(mk({ volumes: [
      { host: volDir, container: "/models", ro: true },
      { host: volDir2, container: "/data" },
    ] }), 65536);
    const seenVols = [];
    for (let i = 0; i < vols.length; i += 1) {
      if (vols[i] === "-v" && vols[i + 1].indexOf(":/hf") < 0) seenVols.push(vols[i + 1]);
    }
    check("多个 volume 都出现且保持顺序/ro",
      JSON.stringify(seenVols) === JSON.stringify([volDir + ":/models:ro", volDir2 + ":/data"]),
      seenVols.join(" | "));

    const userHf = d._dockerArgv(mk({ volumes: [{ host: volDir, container: "/hf" }] }), 65536);
    const hfMounts = [];
    for (let i = 0; i < userHf.length; i += 1) {
      if (userHf[i] === "-v" && userHf[i + 1].endsWith(":/hf")) hfMounts.push(userHf[i + 1]);
    }
    check("用户挂载 /hf 时不重复自动挂载（用户的赢）",
      hfMounts.length === 1 && hfMounts[0] === volDir + ":/hf", hfMounts.join(" | "));
    check("用户挂载 /hf 时 HF_HOME 仍指向 /hf", userHf.indexOf("HF_HOME=/hf") >= 0);

    const sg = mk({ image: "lmsysorg/sglang:latest" });
    const sgArgv = d._dockerArgv(sg, 32768);
    check("sglang 镜像推断 container_port=30000", sg.container_port === 30000, String(sg.container_port));
    check("sglang -p 用 30000", sgArgv[sgArgv.indexOf("-p") + 1] === "127.0.0.1:18080:30000");
    check("sglang 参数是 --model-path/--context-length",
      sgArgv.indexOf("--model-path") >= 0 && sgArgv.indexOf("--context-length") >= 0 &&
      sgArgv.indexOf("--max-model-len") < 0, sgArgv.join(" "));
    check("sglang window 进入 --context-length", sgArgv[sgArgv.indexOf("--context-length") + 1] === "32768");

    const third = mk({ image: "ghcr.io/ggml-org/llama.cpp:server" });
    const thirdArgv = d._dockerArgv(third, 65536);
    check("第三方镜像推断 container_port=8080", third.container_port === 8080, String(third.container_port));
    check("第三方镜像 -p 用 8080", thirdArgv[thirdArgv.indexOf("-p") + 1] === "127.0.0.1:18080:8080");
    check("第三方镜像不加镜像专属参数",
      thirdArgv.indexOf("--model") < 0 && thirdArgv.indexOf("--model-path") < 0, thirdArgv.join(" "));

    const extra = d._dockerArgv(mk({ extra_args: ["--max-num-seqs", "8"] }), 65536);
    check("extra_args 追加在最后", extra.slice(-2).join(" ") === "--max-num-seqs 8", extra.slice(-4).join(" "));
    check("extra_args 在镜像专属参数之后", extra.indexOf("--max-num-seqs") > extra.indexOf("--max-model-len"));

    // --- validation rejects bad input (never cleaned up) -------------------
    function rejects(name, over) {
      let threw = false;
      let msg = "";
      try { mk(over); } catch (e) { threw = true; msg = e.message; }
      check(name, threw, msg || "(没有抛错)");
    }
    rejects("非法 image（空格）", { image: "bad image" });
    rejects("非法 image（分号）", { image: "vllm;rm" });
    rejects("非法 image（反引号）", { image: "vllm" + String.fromCharCode(96) + "whoami" + String.fromCharCode(96) });
    rejects("非法 image（管道）", { image: "vllm|x" });
    rejects("非法 image（美元符）", { image: "vllm$(x)" });
    rejects("非法 image（反斜杠）", { image: "vllm" + String.fromCharCode(92) + "x" });
    rejects("非法 image（引号）", { image: 'vllm"x' });
    rejects("非法 gpus（all,0）", { gpus: "all,0" });
    rejects("非法 gpus（0;1）", { gpus: "0;1" });
    rejects("非法 gpus（abc）", { gpus: "abc" });
    rejects("非法 gpus（-1）", { gpus: "-1" });
    rejects("非法 volume host（相对路径）", { volumes: [{ host: "relative", container: "/c" }] });
    rejects("非法 volume container（相对路径）", { volumes: [{ host: volDir, container: "c" }] });
    rejects("volume host 不存在", { volumes: [{ host: "/no/such/dir/mdp-xyz", container: "/c" }] });
    rejects("volume ro 非布尔", { volumes: [{ host: volDir, container: "/c", ro: "yes" }] });
    rejects("volume 超过 8 条", { volumes: Array.from({ length: 9 }, () => ({ host: volDir, container: "/c" })) });
    rejects("extra_args 非数组", { extra_args: "--foo" });
    rejects("extra_args 非字符串项", { extra_args: [1] });
    rejects("extra_args 超过 32 项", { extra_args: Array.from({ length: 33 }, () => "x") });
    rejects("extra_args 单项超过 200 字符", { extra_args: ["x".repeat(201)] });
    rejects("extra_args 含换行", { extra_args: ["a" + String.fromCharCode(10) + "b"] });
    rejects("extra_args 含 NUL", { extra_args: ["a" + String.fromCharCode(0) + "b"] });

    // --- safePort / DESK-17 ------------------------------------------------
    check("safePort 越界返回 null", safePort(99999) === null && safePort(-1) === null && safePort(0) === null);
    check("safePort 合法值原样返回", safePort(8080) === 8080 && safePort(1024) === 1024);
    check("create 非法端口回退 8000", mk({ port: 99999 }).port === 8000);
    check("create 合法端口保留", mk({ port: 18099 }).port === 18099);

    // --- HF cache mkdir failure only warns ---------------------------------
    const fileAsHome = path.join(dir, "home-file");
    fs.writeFileSync(fileAsHome, "x");
    process.env.HOME = fileAsHome;
    let badHf = null;
    try { badHf = mk({ port: 18100 }); } catch (e) { badHf = { log: ["threw: " + e.message] }; }
    process.env.HOME = fakeHome;
    check("HF 目录建不出来时只告警不阻断",
      badHf && (badHf.log || []).some((l) => l.indexOf("无法创建 HuggingFace") >= 0),
      (badHf && badHf.log || []).join(" | "));

    // --- DESK-18 -----------------------------------------------------------
    let ollamaThrew = false;
    try { d.create({ backend: "ollama" }); } catch (e) { ollamaThrew = true; }
    check("DESK-18：ollama 缺 model_name 创建被拒", ollamaThrew);

    // --- DESK-07: shared ollama model --------------------------------------
    const origFetch = globalThis.fetch;
    let unloads = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).indexOf("/api/generate") >= 0) {
        try {
          const body = JSON.parse(init.body);
          if (body.keep_alive === "0") unloads += 1;
        } catch (e) { /* ignore */ }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };
    try {
      const o1 = d.create({ backend: "ollama", model_name: "qwen3:8b" });
      const o2 = d.create({ backend: "ollama", model_name: "qwen3:8b" });
      d.get(o1.id).status = "RUNNING";
      d.get(o2.id).status = "RUNNING";
      await d.stop(o1.id);
      check("DESK-07：stop A 不卸载共享模型", unloads === 0, "unloads=" + unloads);
      check("DESK-07：B 仍 RUNNING", d.get(o2.id).status === "RUNNING", d.get(o2.id).status);
      check("DESK-07：日志说明保留在 Ollama",
        (d.get(o1.id).log || []).some((l) => l.indexOf("保留在 Ollama") >= 0));
      await d.stop(o2.id);
      check("DESK-07：最后一个引用停止时才卸载", unloads === 1, "unloads=" + unloads);
    } finally {
      globalThis.fetch = origFetch;
    }

    // --- DESK-12: health must reflect real status --------------------------
    const fakeHealth = http.createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => fakeHealth.listen(0, "127.0.0.1", r));
    const hp = fakeHealth.address().port;
    const failed = d.create({ backend: "docker", model_path: "m", port: hp });
    d.get(failed.id).status = "FAILED";
    const hres = await d.health(failed.id);
    check("DESK-12：FAILED 部署即使端口有服务也不报 healthy", hres.healthy === false, JSON.stringify(hres));
    const created = d.create({ backend: "docker", model_path: "m", port: hp });
    const cres = await d.health(created.id);
    check("DESK-12：CREATED 部署不报 healthy", cres.healthy === false, JSON.stringify(cres));
    fakeHealth.close();

    // --- DESK-13: two instances, atomic save, no lost update ---------------
    const cdir = path.join(dir, "concurrent");
    const d1 = new Deployments(cdir, "");
    const d2 = new Deployments(cdir, "");
    d1.create({ backend: "llama.cpp", model_path: "/tmp/x.gguf", port: 9001 });
    d2.create({ backend: "llama.cpp", model_path: "/tmp/x.gguf", port: 9002 });
    const fresh = new Deployments(cdir, "");
    check("DESK-13：双实例并发写不丢更新", fresh.list().length === 2, "count=" + fresh.list().length);
    check("DESK-13：原子写不留 .tmp", !fs.existsSync(path.join(cdir, "deployments.json.tmp")));

    // --- DESK-14: corrupt file is backed up, not silently dropped ----------
    const xdir = path.join(dir, "corrupt");
    fs.mkdirSync(xdir, { recursive: true });
    fs.writeFileSync(path.join(xdir, "deployments.json"), '{"seq":1,"items":[{"id":"x"');
    const dx = new Deployments(xdir, "");
    check("DESK-14：损坏文件不抛、内存为空", dx.list().length === 0);
    check("DESK-14：留下 .bak 备份", fs.existsSync(path.join(xdir, "deployments.json.bak")));

    // --- DESK-20: corrected status is written back -------------------------
    const rdir = path.join(dir, "reload");
    fs.mkdirSync(rdir, { recursive: true });
    fs.writeFileSync(path.join(rdir, "deployments.json"), JSON.stringify({
      seq: 1,
      items: [{ id: "dep_x", backend: "llama.cpp", status: "RUNNING", pid: 12345, log: [] }],
    }));
    const dr = new Deployments(rdir, "");
    const onDisk = JSON.parse(fs.readFileSync(path.join(rdir, "deployments.json"), "utf8"));
    check("DESK-20：纠正后的 STOPPED 回写磁盘",
      onDisk.items[0].status === "STOPPED" && onDisk.items[0].pid === null, JSON.stringify(onDisk.items[0]));
    check("DESK-20：内存里也是 STOPPED", dr.get("dep_x").status === "STOPPED");

    // --- DESK-24: hasBinary timeout ----------------------------------------
    const hangDir = path.join(dir, "hangbin");
    fs.mkdirSync(hangDir, { recursive: true });
    fs.writeFileSync(path.join(hangDir, "which"), ["#!/bin/sh", "sleep 60", ""].join(NL));
    fs.chmodSync(path.join(hangDir, "which"), 0o755);
    const withFake = process.env.PATH;
    process.env.PATH = hangDir + path.delimiter + withFake;
    const t0 = Date.now();
    const got = await hasBinary("definitely-not-here");
    const dt = Date.now() - t0;
    process.env.PATH = withFake;
    check("DESK-24：hasBinary 有 timeout，挂起的 which 不卡死", got === false && dt < 15000, "耗时 " + dt + "ms");

    // --- docker rm -f failure only logs ------------------------------------
    const rmItem = d.create({ backend: "docker", model_path: "m", port: await freePort() });
    process.env.DOCKER_CALLS_FILE = path.join(dir, "calls-rmfail.json");
    process.env.DOCKER_STATE_FILE = path.join(dir, "state-rmfail.json");
    fs.writeFileSync(process.env.DOCKER_CALLS_FILE, "[]");
    fs.writeFileSync(process.env.DOCKER_STATE_FILE, "[]");
    process.env.DOCKER_RM_FAIL = "1";
    let rmThrew = false;
    try { await d._dockerRemove(rmItem); } catch (e) { rmThrew = true; }
    process.env.DOCKER_RM_FAIL = "0";
    check("docker rm -f 失败不抛错、只写日志",
      rmThrew === false && (rmItem.log || []).some((l) => l.indexOf("docker rm -f 未删除容器") >= 0),
      (rmItem.log || []).join(" | "));

    // --- full lifecycle against the fake docker ----------------------------
    async function runDockerCase(label, opts) {
      process.env.DOCKER_CALLS_FILE = path.join(dir, "calls-" + label + ".json");
      process.env.DOCKER_STATE_FILE = path.join(dir, "state-" + label + ".json");
      process.env.DOCKER_ARGS_FILE = path.join(dir, "args-" + label + ".json");
      process.env.DOCKER_HEALTH_MODE = opts.healthMode || "200";
      fs.writeFileSync(process.env.DOCKER_CALLS_FILE, "[]");
      fs.writeFileSync(process.env.DOCKER_STATE_FILE, "[]");
      const dd = new Deployments(path.join(dir, "ddata-" + label), "");
      const port = await freePort();
      const item = dd.create({
        backend: "docker",
        image: opts.image,
        model_path: "Qwen/Qwen3-8B",
        port,
        gpus: "none",
      });
      dd.start(item.id);
      const done = await waitSettled(dd, item.id, 90);
      const status = done.status;
      const log = (done.log || []).slice();
      const argv = JSON.parse(fs.readFileSync(process.env.DOCKER_ARGS_FILE, "utf8"));
      const health = await dd.health(item.id);
      const pid = done.pid;
      const stateBefore = JSON.parse(fs.readFileSync(process.env.DOCKER_STATE_FILE, "utf8"));
      const callsBefore = JSON.parse(fs.readFileSync(process.env.DOCKER_CALLS_FILE, "utf8"));
      await dd.stop(item.id);
      await sleep(700);
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = false; }
      const stateAfter = JSON.parse(fs.readFileSync(process.env.DOCKER_STATE_FILE, "utf8"));
      const callsAfter = JSON.parse(fs.readFileSync(process.env.DOCKER_CALLS_FILE, "utf8"));
      return { dd, item, port, status, log, argv, health, alive, stateBefore, stateAfter, callsBefore, callsAfter };
    }

    const A = await runDockerCase("ok", { image: "vllm/vllm-openai:latest" });
    check("docker 启动到 RUNNING", A.status === "RUNNING", A.status + " | " + (A.log.slice(-1)[0] || ""));
    check("docker run argv 是本地拼的", A.argv[0] === "run" && A.argv[1] === "--rm" &&
      A.argv[A.argv.indexOf("--name") + 1] === "mdp-" + A.item.id, A.argv.join(" "));
    check("宿主/容器端口正确", A.argv[A.argv.indexOf("-p") + 1] === "127.0.0.1:" + A.port + ":8000");
    check("gpus=none 未传 --gpus", A.argv.indexOf("--gpus") < 0);
    check("health 报 healthy", A.health.healthy === true, JSON.stringify(A.health));
    if (process.platform === "darwin") {
      check("darwin 上写出 WARNING 日志",
        A.log.some((l) => l.indexOf("警告") >= 0 && l.indexOf("Docker 也拿不到 GPU") >= 0),
        A.log.filter((l) => l.indexOf("警告") >= 0).join(" | "));
    }
    check("启动前先 docker rm -f 清名字",
      A.callsBefore.some((c) => c[0] === "rm" && c[2] === "mdp-" + A.item.id), JSON.stringify(A.callsBefore));
    check("RUNNING 时容器确实存在（模拟）", A.stateBefore.length === 1, JSON.stringify(A.stateBefore));
    check("stop 后 CLI 进程不存在", A.alive === false);
    check("stop 后容器也被 rm -f 删掉（不是僵尸）",
      A.stateAfter.length === 0 && A.callsAfter.filter((c) => c[0] === "rm").length >= 2,
      JSON.stringify({ state: A.stateAfter, calls: A.callsAfter }));
    check("stop 后 procs 清空", A.dd.procs.size === 0, "size=" + A.dd.procs.size);

    const B = await runDockerCase("fallback", { image: "lmsysorg/sglang:latest", healthMode: "404" });
    check("sglang：/health 404 时回退 /v1/models 仍到 RUNNING",
      B.status === "RUNNING", B.status + " | " + (B.log.slice(-1)[0] || ""));
    check("sglang argv 用 --model-path", B.argv.indexOf("--model-path") >= 0, B.argv.join(" "));
    check("sglang 容器端口 30000", B.argv[B.argv.indexOf("-p") + 1] === "127.0.0.1:" + B.port + ":30000");

    const C = await runDockerCase("del", { image: "vllm/vllm-openai:latest" });
    // Simulate a leftover container, then delete the deployment.
    fs.writeFileSync(process.env.DOCKER_STATE_FILE, JSON.stringify(["mdp-" + C.item.id]));
    const callsBeforeDelete = JSON.parse(fs.readFileSync(process.env.DOCKER_CALLS_FILE, "utf8")).length;
    await C.dd.delete(C.item.id);
    await sleep(300);
    const stateAfterDelete = JSON.parse(fs.readFileSync(process.env.DOCKER_STATE_FILE, "utf8"));
    const callsAfterDelete = JSON.parse(fs.readFileSync(process.env.DOCKER_CALLS_FILE, "utf8"));
    check("delete 时也 docker rm -f 兜底",
      stateAfterDelete.length === 0 && callsAfterDelete.length > callsBeforeDelete &&
      callsAfterDelete[callsAfterDelete.length - 1][0] === "rm",
      JSON.stringify(callsAfterDelete.slice(-1)));

    // --- detectBackends ----------------------------------------------------
    process.env.PATH = fakeBin + path.delimiter + savedPath;
    const be = await new Deployments(path.join(dir, "ddata-detect"), "").detectBackends();
    check("守护进程活着时 docker 可部署", be.backends.indexOf("docker") >= 0, JSON.stringify(be.backends));
    check("可部署的 docker 不列在 installable", !be.installable.docker, JSON.stringify(Object.keys(be.installable)));

    process.env.PATH = "/usr/bin:/bin";
    const be2 = await new Deployments(path.join(dir, "ddata-nodocker"), "").detectBackends();
    check("没有 docker 时走 installable/unavailable 并说明",
      !!(be2.installable.docker || be2.unavailable.docker),
      JSON.stringify({ i: Object.keys(be2.installable), u: Object.keys(be2.unavailable) }));

    console.log(NL + pass + " passed, " + fail + " failed");
    process.exit(fail ? 1 : 0);
  } finally {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
