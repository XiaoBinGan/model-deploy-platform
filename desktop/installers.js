"use strict";

// How to install each backend, and what to say when there is no way to.
//
// Same rule as the launch argv in deploy.js: these are built locally from a
// backend name and never taken from a service. An install runs real commands on
// the user's machine, so the argv has to be a local constant. Every step is an
// argv array run without a shell, so nothing here can be reinterpreted as a
// command line.

const path = require("node:path");

const MLX_VENV = ".mdp-mlx";

// One line each, shown above the install offer so the user knows what they are
// being asked to install.
const BACKEND_INFO = {
  ollama: "最简单，模型由常驻守护进程托管",
  "llama.cpp": "直接跑 GGUF，可精细控制上下文与 KV 量化",
  mlx: "Apple Silicon 上的高吞吐路径，对标 vLLM",
  vllm: "Linux + NVIDIA/AMD 上的高吞吐推理服务",
  sglang: "与 vLLM 同类的推理服务",
  transformers: "HuggingFace 原生，兼容性最好但最慢",
};

function manual(steps) {
  return steps.map((s) => s.argv.join(" ")).join("\n");
}

// Reason-only entries: there is no command that would fix these, and pretending
// otherwise would send the user off to run something that cannot work.
//
// Two different kinds of "no", which the UI must not conflate:
//   "platform" - this machine cannot have it, whatever you install
//   "runtime"  - it may well be installed; the desktop app just cannot run it
function cannot(reason, hint, kind) {
  return { ok: false, reason, manual: hint || "", kind: kind || "platform" };
}

async function installPlan(name, ctx) {
  const { platform, arch, has } = ctx;
  const home = ctx.home;

  if (name === "transformers") {
    return cannot(
      "transformers 的 runtime 在服务端代码里（app/runtimes/transformers_server.py），" +
      "桌面端本地没有这个模块。这不是没装的问题——装了也一样跑不起来。",
      "要用它，请在控制面所在机器上部署。",
      "runtime"
    );
  }

  if (name === "mlx") {
    if (platform !== "darwin" || arch !== "arm64") {
      return cannot("MLX 只在 Apple Silicon（macOS + arm64）上有意义。");
    }
    const venv = path.join(home, MLX_VENV);
    const py = platform === "win32" ? "python" : "python3";
    const steps = [
      {
        note: "建一个独立 venv（Homebrew 和多数发行版的 Python 受 PEP 668 管控，直接 pip install 会被拒绝）",
        argv: [py, "-m", "venv", venv],
      },
      { note: "在 venv 里装 mlx-lm", argv: [path.join(venv, "bin", "pip"), "install", "mlx-lm"] },
    ];
    return { ok: true, backend: name, steps, manual: manual(steps) };
  }

  if (name === "llama.cpp") {
    if (platform === "darwin") {
      if (!(await has("brew"))) {
        return cannot("需要 Homebrew，但没找到 brew。", "brew install llama.cpp");
      }
      const steps = [{ note: "用 Homebrew 装 llama.cpp（含 llama-server）", argv: ["brew", "install", "llama.cpp"] }];
      return { ok: true, backend: name, steps, manual: manual(steps) };
    }
    if (platform === "linux" && (await has("brew"))) {
      const steps = [{ note: "用 Homebrew 装 llama.cpp", argv: ["brew", "install", "llama.cpp"] }];
      return { ok: true, backend: name, steps, manual: manual(steps) };
    }
    return cannot(
      platform === "win32"
        ? "Windows 上没有可靠的包管理器渠道，需要手动下载。"
        : "没有找到 Homebrew，需要手动构建。",
      "https://github.com/ggml-org/llama.cpp/releases"
    );
  }

  if (name === "ollama") {
    if (platform === "darwin" && (await has("brew"))) {
      const steps = [{
        note: "装 Ollama 桌面版（装完还需要启动一次，守护进程才会监听 11434）",
        argv: ["brew", "install", "--cask", "ollama"],
      }];
      return { ok: true, backend: name, steps, manual: manual(steps) };
    }
    if (platform === "win32" && (await has("winget"))) {
      const steps = [{
        note: "用 winget 装 Ollama（装完还需要启动一次）",
        argv: ["winget", "install", "--id", "Ollama.Ollama", "-e", "--accept-source-agreements"],
      }];
      return { ok: true, backend: name, steps, manual: manual(steps) };
    }
    return cannot("没有找到可用的包管理器。", "https://ollama.com/download");
  }

  if (name === "vllm" || name === "sglang") {
    if (platform === "linux") {
      const pkg = name === "vllm" ? "vllm" : "sglang[all]";
      const steps = [{
        note: "装到当前 Python 环境（需要 NVIDIA/AMD 驱动和 CUDA/ROCm）。" +
          "官方镜像 vllm/vllm-openai + nvidia-container-toolkit 是更常见的做法，" +
          "但那条路要把模型目录挂进容器，这里装原生包更直接",
        argv: ["python3", "-m", "pip", "install", pkg],
      }];
      return { ok: true, backend: name, steps, manual: manual(steps) };
    }
    if (platform === "darwin") {
      // Docker does not rescue this one, and users will ask, so say why rather
      // than leaving "no wheel" as the whole story.
      return cannot(
        name + " 官方只发 manylinux 的 x86_64 / aarch64 wheel，没有 macOS 版本。" +
        "Docker 也不行：Docker Desktop 的 GPU 支持只在 Windows 的 WSL2 后端提供，" +
        "macOS 上容器拿不到 GPU，纯 CPU 跑远远达不到可用速度。" +
        "Mac 上对应的东西是 MLX。",
        "https://docs.vllm.ai/en/latest/deployment/docker.html"
      );
    }
    return cannot(
      name + " 不能在原生 Windows 上跑。可行的路径是 WSL2 + NVIDIA 驱动 + Docker" +
      "（WSL2 本身没有版本限制，家庭版也能装），但整个过程要在 WSL2 里做。" +
      "机器上没有 NVIDIA 显卡的话，这条路径也不通。",
      "https://docs.vllm.ai/en/latest/deployment/docker.html"
    );
  }

  return cannot("桌面端不认识这个后端。");
}

module.exports = { installPlan, BACKEND_INFO, MLX_VENV };
