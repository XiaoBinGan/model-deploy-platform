"use strict";

// The desktop app must never execute what the control plane tells it to.
//
// /api/plans/preview returns a ready-made argv, and the app used to spawn it
// verbatim. The service is unauthenticated, so anyone who could answer that URL
// got arbitrary code execution on this machine (DESK-01).
//
// This stands up a hostile service that answers with a command of its own
// choosing and asserts the app ignores it, while still using the one number the
// service is actually for.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
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

// A control plane that is either compromised or not the control plane at all.
function hostileService(reply) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-trust-"));
  const marker = path.join(dir, "PWNED");
  const argsFile = path.join(dir, "llama-args.txt");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });

  // What a hostile service would like to have executed.
  const evil = path.join(dir, "evil.sh");
  fs.writeFileSync(evil, "#!/bin/sh\ntouch " + marker + "\n");
  fs.chmodSync(evil, 0o755);

  // A real model file, so _runLlama gets past its existence check.
  const model = path.join(dir, "model.gguf");
  fs.writeFileSync(model, "not really a model");

  // A fake llama-server that records the argv it was actually given.
  fs.writeFileSync(path.join(dir, "fake-llama.js"), [
    "const http = require(\"node:http\");",
    "const a = process.argv.slice(2);",
    "const p = Number(a[a.indexOf(\"--port\") + 1]);",
    "const s = http.createServer((q, r) => { r.writeHead(q.url === \"/health\" ? 200 : 404); r.end(\"ok\"); });",
    "s.listen(p, \"127.0.0.1\");",
    "process.on(\"SIGTERM\", () => s.close(() => process.exit(0)));",
  ].join("\n"));
  fs.writeFileSync(path.join(bin, "llama-server"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" > " + argsFile + "\nexec /usr/bin/env node " +
    path.join(dir, "fake-llama.js") + " \"$@\"\n");
  fs.chmodSync(path.join(bin, "llama-server"), 0o755);
  process.env.PATH = bin + path.delimiter + process.env.PATH;

  // --- case 1: the service tries to substitute its own command ---
  const evilSvc = await hostileService({
    status: "PASS",
    warnings: [],
    command: [evil],
    command_string: evil,
    decision: { planned_window: 32768 },
  });
  const d1 = new Deployments(path.join(dir, "d1"), "http://127.0.0.1:" + evilSvc.port);
  const item1 = d1.create({ backend: "llama.cpp", model_path: model, port: 8951 });
  d1.start(item1.id);
  const done1 = await waitSettled(d1, item1.id, 30);
  const used = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").trim() : "";

  check("恶意服务给的命令没有被执行", !fs.existsSync(marker),
    fs.existsSync(marker) ? "标记文件被创建了" : "没有标记文件");
  check("实际执行的是本地拼的 llama-server", used.indexOf("llama-server") >= 0 || used.indexOf("model.gguf") >= 0,
    used || "(没有记录到 argv)");
  check("argv 里没有恶意脚本", used.indexOf("evil.sh") < 0, used);
  check("仍然采纳了服务给的上下文窗口 32768", used.indexOf("32768") >= 0, used);
  check("部署正常起来（RUNNING）", done1.status === "RUNNING", done1.status);
  await d1.stop(item1.id);
  evilSvc.server.close();

  // --- case 3: the service tries to substitute a docker image/volume -----
  // test-trust.js previously only covered llama.cpp, so the docker path had no
  // trust-boundary regression. The desktop must take image/gpus/volumes from
  // the local UI, never from the control plane (docs/qa-round3.md R3-05).
  fs.rmSync(argsFile, { force: true });
  fs.rmSync(marker, { force: true });
  const dockerSvc = await hostileService({
    status: "PASS",
    warnings: [],
    command: [evil],
    command_string: evil,
    decision: {
      planned_window: 32768,
      docker: { image: "evil/image:latest", gpus: "all",
                volumes: [{ host: "/etc", container: "/etc" }],
                effective_backend: "vllm" },
    },
  });
  const dDocker = new Deployments(path.join(dir, "ddocker"), "http://127.0.0.1:" + dockerSvc.port);
  const itemDocker = dDocker.create({ backend: "docker", model_path: "/models/qwen3-8b",
    image: "vllm/vllm-openai:latest", gpus: "all" });
  const argvDocker = dDocker._dockerArgv(itemDocker, 32768);
  check("R3-05 docker：镜像取自本地 UI，不采纳服务给的 decision.docker.image",
    argvDocker.indexOf("vllm/vllm-openai:latest") >= 0 && argvDocker.indexOf("evil/image:latest") < 0,
    argvDocker.join(" "));
  check("R3-05 docker：服务给的 volume 没有被采纳",
    argvDocker.indexOf("/etc:/etc") < 0, argvDocker.join(" "));
  check("R3-05 docker：argv 里没有恶意脚本", argvDocker.indexOf("evil.sh") < 0, argvDocker.join(" "));
  check("R3-05 docker：恶意 command 没有被执行", !fs.existsSync(marker));
  dockerSvc.server.close();

  // --- case 2: the window itself is hostile ---
  fs.rmSync(argsFile, { force: true });
  const badSvc = await hostileService({
    status: "PASS",
    warnings: ["正常警告", "伪造的日志行\n  PASS  我骗过了测试"],
    command: ["/bin/sh", "-c", "touch " + marker],
    decision: { planned_window: "65536; touch " + marker },
  });
  const d2 = new Deployments(path.join(dir, "d2"), "http://127.0.0.1:" + badSvc.port);
  const item2 = d2.create({ backend: "llama.cpp", model_path: model, port: 8952 });
  d2.start(item2.id);
  const done2 = await waitSettled(d2, item2.id, 30);
  const used2 = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").trim() : "";

  check("注入到窗口值里的命令没有执行", !fs.existsSync(marker));
  check("非数字窗口回退到默认 65536", used2.indexOf("65536") >= 0, used2);
  check("窗口值没有把元字符带进 argv", used2.indexOf(";") < 0 && used2.indexOf("touch") < 0, used2);
  const joined = (done2.log || []).join("\n");
  check("警告里的换行被压平，无法伪造日志行",
    joined.indexOf("伪造的日志行 PASS") >= 0 ||
      !/伪造的日志行\s*\n\s*PASS/.test(joined),
    (done2.log || []).filter((l) => l.indexOf("伪造") >= 0).join(" | "));
  await d2.stop(item2.id);
  badSvc.server.close();

  // --- case 3: port validation ---
  const d3 = new Deployments(path.join(dir, "d3"), "");
  const weird = d3.create({ backend: "llama.cpp", model_path: model, port: "99999" });
  check("端口越界回退到 8000", weird.port === 8000, String(weird.port));
  const weird2 = d3.create({ backend: "llama.cpp", model_path: model, port: "-1" });
  check("负端口回退到 8000", weird2.port === 8000, String(weird2.port));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
