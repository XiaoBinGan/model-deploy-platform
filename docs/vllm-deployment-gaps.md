# vLLM 部署实测报告（Apple Silicon）

- 平台：macOS 26.5.1 / arm64 / Apple M5 / 24GB 统一内存
- 方法：用桌面端 app 的真实接口走完整流程（创建 → 启动 → 健康检查 → 发消息）
- 结论：**vLLM 在这台机器上不可能运行**，但实测暴露出 7 个真正缺失的功能，
  其中 4 个与 vLLM 无关，是普遍问题。

---

## 一、为什么 vLLM 在这台 Mac 上跑不了

PyPI 最新版 vllm 0.30.0 提供的 wheel：

    平台分布:
      manylinux_2_28_x86_64  -> 1
      manylinux_2_28_aarch64 -> 1
    macOS/arm64 wheel: 无
    sdist: vllm-0.30.0.tar.gz

只有 Linux wheel，macOS 只有源码包。而 vLLM 的源码依赖 CUDA / ROCm 内核，
在 macOS 上编译不过，也没有 Metal 后端。

所以「用 vLLM 在这台 Mac 上部署」这个目标本身不成立。这是平台约束，
不是 app 的缺陷。**app 把它标为 BLOCKED 是对的，但只对了一半**（见第 6 条）。

---

## 二、实测：app 对每个后端的实际行为

用 app 的接口逐个创建并启动：

| 后端 | 创建 | 启动结果 | 说明 |
|---|---|---|---|
| ollama | 成功 | STARTING → RUNNING | 唯一真正可用的 |
| llama.cpp | 成功 | FAILED | 代码路径完整，但本机没装 llama-server |
| transformers | 成功 | **BLOCKED** | 系统推荐给 Apple Silicon 的后端，桌面端却没实现 |
| vllm | 成功 | BLOCKED | 平台不支持 |
| sglang | 成功 | BLOCKED | 平台不支持 |

关键点：**五个后端全部创建成功**，失败发生在启动阶段。
用户看到的是「我选了 vllm，点了部署，然后失败」，而不是「这个后端在本机不可用」。

---

## 三、缺的功能

### 1. 后端可用性没有贯通到 UI（最该修）

- /api/backends 正确返回 {"backends":["ollama"]}
- 前端确实请求了它（frontend/index.html:521，存进 CONFIG）
- **但从来没用它过滤下拉框**。CONFIG 只被读了 allow_remote_deploy 一个字段
- 两个后端下拉（frontend/index.html:84 和 :107）都是硬编码的五个选项

应该：下拉只列出可用后端，不可用的置灰并说明原因。
这是 QA 报告里的 F-09，实测确认。

### 2. transformers 是系统推荐给 Apple Silicon 的，桌面端却没实现（最矛盾）

app/services/environment.py:32 明确写着：

    recommended_backends: ["ollama","transformers"] if apple_silicon
                          else ["vllm","sglang","ollama","transformers"]

但 desktop/deploy.js 的 _run() 只实现了 ollama 和 llama.cpp：

    if (item.backend === "ollama") return this._runOllama(item, gen);
    if (item.backend === "llama.cpp" || ...) return this._runLlama(item, gen);
    item.status = "BLOCKED";
    this._log(item, item.backend + " 在桌面端不支持：它面向 Linux 服务器，请改用 ollama 或 llama.cpp。");

**系统推荐的东西，自己的桌面端不支持。** 而且提示语「它面向 Linux 服务器」
对 transformers 来说是错的——它恰恰是 Mac 上的推荐后端。

### 3. 缺 MLX 后端（Mac 上真正对标 vLLM 的东西）

如果目标是「在 Mac 上跑高性能本地推理」，对标 vLLM 的不是 vLLM，是 MLX。

- 本机 ollama 里已经有 qwen3.8:27b-mlx（18.17GB），说明用户已经在用 MLX 权重
- 但 mlx / mlx_lm 都没装，app 也没有 mlx 后端选项
- mlx-lm 自带 OpenAI 兼容 server（mlx_lm.server），接进来的成本很低

建议加一个 mlx 后端，它才是 Apple Silicon 上 vLLM 的对应物。

### 4. 没有删除部署的功能（实测最直接的痛点）

实测中创建了 22 个测试部署，**没有任何办法删掉它们**。

- 控制面路由：POST /api/deployments、start、stop、GET list、GET one、health、test
- **没有 DELETE**（backend/app/main.py 全部路由里没有）
- 桌面端 server.js 同样没有
- 前端只有「启动 / 停止 / 日志」三个按钮

现在这 22 条垃圾记录只能留在列表里。部署列表会越用越乱。
应该：加 DELETE /api/deployments/{id}，UI 加删除按钮。

### 5. 错误提示没有安装引导

对比两种失败信息：

- llama.cpp：「PATH 里没有 llama-server。请先安装 llama.cpp（例如 brew install llama.cpp）」
  —— 有原因、有命令
- vllm / sglang / transformers：「桌面端不支持：它面向 Linux 服务器」
  —— 没说为什么、也没说怎么办

应该：vLLM 的提示应该说明「官方只提供 Linux wheel，Apple Silicon 装不了，
本机请用 ollama 或 MLX」。用户才不会反复尝试。

### 6. planner 对非 Linux 平台仍生成 CUDA 专用命令

backend/app/services/planner.py:131-136 对任何平台都生成：

    vllm serve Qwen/Qwen3-8B --host 127.0.0.1 --port 8000 --dtype bfloat16
      --max-model-len 65536 --gpu-memory-utilization 0.9 --max-num-seqs 8

--gpu-memory-utilization 是 CUDA 概念，Apple Silicon 上没有独立显存，
这个参数没有意义。planner 不检查平台。

而且控制面对 vllm 返回的是 status=WARNING（不是 BLOCKED），
只在 warnings 里说「无法完全驻留，溢出约 3.1GB」。平台不兼容没有体现。

### 7. 创建时不校验后端可用性

POST /api/deployments 对任何后端名都返回 200 和 id，
即使该后端不可用、甚至不存在。校验推迟到 start 阶段。

应该：创建时就返回 4xx 并说明，或者前端在提交前禁用不可用后端。

---

## 三补、修复状态

已修 2 条（P0），提交见下方 git log：

| 编号 | 状态 | 修复方式 |
|---|---|---|
| 4 | 已修 | 新增 DELETE /api/deployments/{id}（后端 + 桌面端 + 前端按钮），删除前先停止；列表从 22 条清到 6 条实测通过 |
| 1 | 已修 | 前端 fillBackends() 按 /api/backends 过滤两个下拉，不可用的置灰并标注「本机未安装 / 桌面端不支持」；桌面端 /api/backends 改为只报告可部署的后端，另给 installed 字段说明已装但不可用的 |

未修：2（transformers 后端未实现）、3（MLX 后端）、5（错误引导）、6（planner 平台判定）、7（创建时校验）。

## 四、建议的处理顺序

| 优先级 | 内容 | 理由 |
|---|---|---|
| P0 | 加删除部署功能 | 实测最痛，列表已经不可用 |
| P0 | 后端下拉按 /api/backends 过滤 | 数据已经在手，只差没接上；消除「选了才失败」 |
| P1 | 实现 transformers 后端 | 系统自己推荐了却不支持，自相矛盾 |
| P1 | 加 MLX 后端 | Mac 上真正对标 vLLM 的能力，成本低 |
| P2 | 失败信息补安装引导 | 按后端分别给原因和命令 |
| P2 | planner 增加平台兼容性判定 | 把 environment.py 已有的知识贯通到 planner |
| P3 | 创建时校验后端 | 早失败早提示 |

---

## 五、一句话总结

vLLM 跑不了是 Mac 的硬约束，不是 app 的问题。
但顺着这条线测出来的是：**这个 app 对「后端」这个概念只实现了三分之一**——
探测到了（/api/backends）、推荐了（environment.py）、却没有校验、没有过滤、
没有删除、也没有把 Mac 上真正该用的 MLX 接进来。
