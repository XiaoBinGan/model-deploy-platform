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

  const macVllm = await installPlan("vllm", mac);
  check("装不了时给出的是原因，不是命令",
    !macVllm.ok && macVllm.reason.indexOf("macOS") >= 0, macVllm.reason.slice(0, 60));
  const mlxPlan = await installPlan("mlx", mac);
  check("可装时每一步都是 argv 数组（不经过 shell）",
    mlxPlan.steps.every((s) => Array.isArray(s.argv) && s.argv.length > 0));
  check("mlx 的第一步是建 venv", mlxPlan.steps[0].argv.indexOf("venv") >= 0, mlxPlan.steps[0].argv.join(" "));
  check("每个后端都有说明文案",
    ["ollama", "llama.cpp", "mlx", "vllm", "sglang", "transformers"].every((b) => BACKEND_INFO[b]));

  // --- the step runner ------------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-install-"));
  const d = new Deployments(path.join(dir, "data"), "");

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
