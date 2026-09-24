"use strict";

// The install path runs real commands on the user's machine, so this test never
// triggers a real one. It exercises the plumbing: the plan table, the step
// runner, the SSE framing, and the refusal paths.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installPlan, BACKEND_INFO } = require("./installers");
const { Deployments } = require("./deploy.js");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
  if (ok) pass += 1;
  else fail += 1;
}

// Captures what would have been streamed to the window.
function fakeRes() {
  const chunks = [];
  return {
    ended: false,
    write(s) { chunks.push(String(s)); return true; },
    end() { this.ended = true; },
    events() {
      return chunks.join("")
        .split("\n\n")
        .filter((b) => b.trim())
        .map((b) => JSON.parse(b.replace(/^data: /, "")));
    },
    raw() { return chunks.join(""); },
  };
}

const noBrew = () => Promise.resolve(false);
const allTools = () => Promise.resolve(true);

(async () => {
  // --- the plan table is a local constant, per platform ---------------------
  const mac = { platform: "darwin", arch: "arm64", home: "/Users/x", has: allTools };
  const win = { platform: "win32", arch: "x64", home: "C:/Users/x", has: allTools };
  const lin = { platform: "linux", arch: "x86_64", home: "/home/x", has: allTools };

  check("mlx 在 Apple Silicon 上可装", (await installPlan("mlx", mac)).ok);
  check("mlx 在 Windows 上装不了", !(await installPlan("mlx", win)).ok);
  check("llama.cpp 在 mac 有 brew 时可装", (await installPlan("llama.cpp", mac)).ok);
  check("llama.cpp 在 mac 无 brew 时说明原因", !(await installPlan("llama.cpp", { ...mac, has: noBrew })).ok);
  check("vllm 在 Linux 可装", (await installPlan("vllm", lin)).ok);
  check("vllm 在 mac 装不了", !(await installPlan("vllm", mac)).ok);
  check("sglang 在 mac 装不了", !(await installPlan("sglang", mac)).ok);
  check("transformers 在哪儿都装不了（runtime 在服务端）",
    !(await installPlan("transformers", mac)).ok && !(await installPlan("transformers", lin)).ok);

  // "Cannot install here" and "this app cannot run it" must not be conflated:
  // the second is not fixed by installing anything.
  const tf = await installPlan("transformers", mac);
  const vm = await installPlan("vllm", mac);
  check("transformers 标为 runtime（装了也没用）", tf.kind === "runtime", "kind=" + tf.kind);
  check("vllm 标为 platform（平台就没有）", vm.kind === "platform", "kind=" + vm.kind);
  check("两者都是 ok:false 但类别不同", !tf.ok && !vm.ok && tf.kind !== vm.kind);

  // --- the GPU / Docker assessment is pure, so it is testable without a GPU ---
  const { gpuPath } = require("./installers");

  check("macOS：明确回答 Docker 也不行",
    gpuPath({ platform: "darwin", docker: true, nvidia: false }).indexOf("Docker 也拿不到 GPU") >= 0);
  check("Windows：有显卡 + Docker 时给出可行路径",
    gpuPath({ platform: "win32", docker: true, nvidia: true }).indexOf("WSL2 + Docker") >= 0);
  check("Windows：有显卡但没 Docker 时说去装 Docker",
    gpuPath({ platform: "win32", docker: false, nvidia: true }).indexOf("装 Docker Desktop") >= 0);
  check("Windows：没显卡时说这条路不通",
    gpuPath({ platform: "win32", docker: true, nvidia: false }).indexOf("这条路不通") >= 0);
  check("Linux：有显卡 + Docker 时提到官方镜像",
    gpuPath({ platform: "linux", docker: true, nvidia: true }).indexOf("vllm/vllm-openai") >= 0);
  check("Linux：没显卡时警告 CPU 达不到可用速度",
    gpuPath({ platform: "linux", docker: false, nvidia: false }).indexOf("CPU") >= 0);
  check("四种平台都给出非空判断",
    ["darwin", "win32", "linux"].every((p) =>
      [true, false].every((d2) => [true, false].every((n) => gpuPath({ platform: p, docker: d2, nvidia: n }).length > 0))));
  check("缺少 caps 时不崩", typeof gpuPath({}) === "string" && gpuPath({}).length > 0);

  const vmCaps = await installPlan("vllm", { ...mac, caps: { platform: "darwin", docker: false, nvidia: false } });
  check("vllm 的理由里带上了 GPU/Docker 判断", vmCaps.gpu.indexOf("Docker") >= 0, vmCaps.gpu.slice(0, 36));

  const macVllm = await installPlan("vllm", mac);
  check("装不了时给出的是原因，不是命令",
    !macVllm.ok && macVllm.reason.indexOf("macOS") >= 0, macVllm.reason.slice(0, 60));
  const mlxPlan = await installPlan("mlx", mac);
  check("可装时每一步都是 argv 数组（不经过 shell）",
    mlxPlan.steps.every((s) => Array.isArray(s.argv) && s.argv.length > 0));
  check("mlx 的第一步是建 venv", mlxPlan.steps[0].argv.indexOf("venv") >= 0, mlxPlan.steps[0].argv.join(" "));
  check("每个后端都有说明文案",
    ["ollama", "llama.cpp", "mlx", "vllm", "sglang", "transformers", "docker"].every((b) => BACKEND_INFO[b]));

  // --- docker install plan (docs/docker-design.md §7) -----------------------
  const noDocker = (n) => Promise.resolve(n !== "docker");
  const macNoDocker = { ...mac, has: noDocker };
  const winNoDocker = { ...win, has: noDocker };
  const linNoDocker = { ...lin, has: noDocker };

  const dmac = await installPlan("docker", macNoDocker);
  check("docker 在 mac 有 brew 时可装", dmac.ok, dmac.ok ? "" : dmac.reason);
  check("docker 安装计划用 brew --cask docker",
    dmac.ok && dmac.steps[0].argv.join(" ") === "brew install --cask docker",
    dmac.ok ? dmac.steps[0].argv.join(" ") : dmac.reason);
  const dwin = await installPlan("docker", winNoDocker);
  check("docker 在 win 有 winget 时可装",
    dwin.ok && dwin.steps[0].argv.indexOf("Docker.DockerDesktop") >= 0,
    dwin.ok ? dwin.steps[0].argv.join(" ") : dwin.reason);
  const dlin = await installPlan("docker", linNoDocker);
  check("docker 在 linux 上 cannot（不猜发行版命令）", !dlin.ok, dlin.ok ? "ok" : dlin.reason);
  check("docker linux 理由说明需要 root", !dlin.ok && dlin.reason.indexOf("root") >= 0, dlin.reason);
  check("docker linux 不给 curl|sh 之类命令",
    !dlin.ok && dlin.manual.indexOf("|") < 0 && dlin.manual.indexOf("get.docker.com") < 0, dlin.manual);
  const ddown = await installPlan("docker", mac);
  check("docker 已装但守护进程没起来时给启动说明",
    ddown.ok && ddown.steps.length === 0 && ddown.manual.indexOf("守护进程") >= 0, ddown.manual);
  check("docker 也带上 GPU/Docker 判断", typeof dmac.gpu === "string" && dmac.gpu.length > 0);

  // --- the step runner ------------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-install-"));
  const d = new Deployments(path.join(dir, "data"), "");

  // --- the probe itself ---
  const caps = await d._caps();
  check("_caps 返回 platform/docker/nvidia",
    typeof caps.platform === "string" && typeof caps.docker === "boolean" && typeof caps.nvidia === "boolean",
    JSON.stringify(caps));
  // _caps short-circuits on hasBinary("docker"), so on a machine without
  // Docker this never runs - which is exactly how a malformed argv in it went
  // unnoticed. Call it directly so the argv is exercised everywhere.
  const alive = await d._dockerAlive();
  check("_dockerAlive 返回布尔，参数不合法也不抛", typeof alive === "boolean", "got " + alive);
  const probed = await d.detectBackends();
  check("detectBackends 带上 caps", !!probed.caps, JSON.stringify(probed.caps));
  check("每个装不了的后端都带 GPU 判断或为空",
    Object.values(probed.unavailable || {}).every((v) => typeof v.gpu === "string"));

  const seen = [];
  const okCode = await d._runInstallStep(
    { note: "回显", argv: ["/bin/echo", "hello-from-install"] },
    (line) => seen.push(line),
  );
  check("成功步骤返回 0", okCode === 0, "code=" + okCode);
  check("步骤输出被逐行回调", seen.some((l) => l.indexOf("hello-from-install") >= 0), seen.join(" | "));
  check("步骤跑完从 procs 里摘掉", d.procs.size === 0, "size=" + d.procs.size);

  const failCode = await d._runInstallStep(
    { note: "失败", argv: ["/bin/sh", "-c", "exit 3"] },
    () => {},
  );
  check("失败步骤返回真实退出码", failCode === 3, "code=" + failCode);

  const missingCode = await d._runInstallStep(
    { note: "不存在的命令", argv: ["/nonexistent/binary-xyz"] },
    (line) => seen.push(line),
  );
  check("命令不存在不会抛异常，返回非 0", missingCode !== 0, "code=" + missingCode);

  // --- SSE plumbing ---------------------------------------------------------
  const r1 = fakeRes();
  await d.installStream("nonsense-backend", r1);
  const e1 = r1.events();
  check("不认识的后端：单个 error 事件", e1.length === 1 && e1[0].type === "error", JSON.stringify(e1));
  check("error 事件带原因", !!(e1[0] && e1[0].reason), e1[0] && e1[0].reason);
  check("响应被正常结束", r1.ended === true);

  const r2 = fakeRes();
  await d.installStream("transformers", r2);
  const e2 = r2.events();
  check("装不了的后端：走 error 而不是开始安装",
    e2.length === 1 && e2[0].type === "error", JSON.stringify(e2.map((e) => e.type)));
  check("error 说明为什么装不了",
    !!(e2[0] && e2[0].reason && e2[0].reason.indexOf("服务端") >= 0), e2[0] && e2[0].reason);

  check("SSE 每帧都以 data: 开头并以空行结尾",
    r2.raw().split("\n\n").filter((b) => b.trim()).every((b) => b.indexOf("data: ") === 0),
    JSON.stringify(r2.raw().slice(0, 40)));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
