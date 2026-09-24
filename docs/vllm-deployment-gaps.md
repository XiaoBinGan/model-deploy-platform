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

第二轮又修了 3 条：

| 编号 | 状态 | 修复方式 |
|---|---|---|
| 3 | 已修 | **新增 MLX 后端**。mlx-lm 提供 OpenAI 兼容的 mlx_lm.server（/v1/chat/completions、/v1/models、/health）。desktop 新增 _runMlx()：平台必须是 darwin+arm64，检测装了 mlx_lm 的 python，命令 mlx_lm.server --model <HF repo> --host 127.0.0.1 --port <p> --kv-bits 8。--kv-bits 8 对应项目一直承诺的 q8_0 KV 量化，这是在统一内存上撑住 64K 上下文的办法。模型用 mlx-community 的 4bit 权重。 |
| 2 | 已改设计 | transformers **在控制面里本来就实现了**（backend/app/runtimes/transformers_server.py + transformers_runtime.py + planner.py:149），但那个 runtime 模块在服务端代码里，桌面端本地跑不了——所以「桌面端不支持」这个判断本身没错，错的是 environment.py 把它列为 Apple Silicon 的推荐后端。已改为 recommended_backends: ["ollama","mlx"]，并新增 MLX 检查项。 |
| — | 已修 | /api/hardware/probe-command 把 User-Agent 当平台名（见 windows-gaps.md） |

MLX 后端不需要真装 mlx-lm 就能测：desktop/test-mlx.js 会造一个假的 python3
（回应 import mlx_lm，并起一个真的 /health 服务），覆盖探测、启动、参数、
健康检查、停止杀进程。10/10 通过。

第三轮（Mac 完善）又修了 3 条，全部来自真装 mlx-lm 之后暴露的问题：

| 编号 | 状态 | 修复方式 |
|---|---|---|
| — | 已修 | **GPU 表：Apple M5 查不到**。表里有 m1~m4 却没有 m5，而本机就是 M5。更隐蔽的是 normalize() 把 "gpu" 当噪声词删掉，所以 "Apple GPU" 变成裸 "apple"，永远匹配不到 "apple gpu" 这个键。已补 m5/m5 pro/m5 max，并把键改成 "apple"。 |
| — | 已修 | **GPU 表的数字前缀误匹配**。"rtx 40900" 会子串命中 "rtx 4090" 并借走 24GB。加了「数字结尾的键后面不能紧跟数字」的边界规则，同时不影响 "geforce mx" 这种合法前缀（MX150 仍能命中）。 |
| 3 补 | 已修 | **catalog 里一个 MLX 模型都没有**。MLX 后端有了、模型却选不出来。现在 22 个条目都有 mlx-community/*-4bit 变体，仓库 id 由 HuggingFace id 按约定推导，另有一条 network 测试对着 Hub 校验全部 23 个仓库确实存在。 |

真装 mlx-lm（0.31.3）跑通之后发现的三个坑，都已处理：

1. **python -m mlx_lm.server 已废弃** —— 改为 python -m mlx_lm server
2. **--kv-bits 在已发布版本里不存在**（只在 GitHub main）—— 传进去直接退出码 2，
   部署起不来。现在启动前跑一次 --help 问版本，只在支持时才传
3. **/health 返回 200 不等于模型能用** —— mlx_lm.server 先绑端口再加载权重，
   ModelProvider 是按需加载。实测 0.5B 模型从启动到能回答用了 382 秒，
   而 /health 在 3 秒内就 200。现在健康检查通过后再做一次 warmup
   （一 token 补全）强制触发加载，加载完才标记 RUNNING

真机实测（Apple M5 / 24GB）：

    后端探测   ["ollama","mlx"]
    启动耗时   382.4s（0.5B 模型，含首次下载 6 分钟）
    对话       ok=true  reply="我是来自阿里云的大规模语言模型，我叫通义千问。"
    usage      {prompt_tokens:33, completion_tokens:17}
    停止       pid 已不存在，procs=0

未修：5（错误引导）、6（planner 平台判定）、7（创建时校验）。

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

---

## 六、第四轮：gap 5 已修（失败信息补安装引导）

第 177 行「未修：5（错误引导）」在第四轮处理。`desktop/deploy.js` 的 `_run()` 对桌面端
没有启动路径的后端，不再只写一句「桌面端不支持」，而是分后端说清「为什么」和「下一步」：

- `transformers`：runtime 在控制面服务端（`backend/app/runtimes/transformers_server.py`），
  桌面端本地没有这个模块——这不是没装的问题，装了也一样跑不起来。下一步是去控制面所在
  机器部署，本机想跑本地模型请用 ollama 或 mlx。
- `vllm` / `sglang`：官方只发 Linux wheel，没有 macOS 版本，桌面端无法本地启动。
  「为什么」直接复用 `installers.js` 的 `gpuPath(caps)`，不再另写一套 GPU/Docker 文案；
  「下一步」在 macOS 上指向 mlx 或 docker 后端，在 Linux 上指向 `pip install` 或 docker 后端。

这样失败日志和安装弹框用的是同一套平台判断，两处不会再说出互相矛盾的话。

同轮还落地了 docker 后端（`docs/docker-design.md`）：`_dockerArgv()` 本地拼装 argv、
`create()` 校验 image/gpus/volumes/extra_args、`_runDocker()` 启动容器并在
启动/停止/删除三处 `docker rm -f` 兜底，测试见 `desktop/test-docker.js`。

---

## 七、第四轮续：gap 6 / gap 7 已修

第 177 行「未修：5（错误引导）、6（planner 平台判定）、7（创建时校验）」现在**全部关闭**。

### gap 6：planner 对非 Linux 平台仍生成 CUDA 专用命令 —— 已修

`environment.py` 抽出 `is_apple_silicon(system, architecture)` 与 `nvidia_devices()`，
`planner._cuda_platform()` 复用它们（不再各写一套探测）。

- 平台优先取**客户端档案**（`req.hardware.platform/architecture/gpus`），
  只有没有档案时才探测控制面本机。
- 非 NVIDIA 目标上，vllm 的 `--gpu-memory-utilization` 与 sglang 的
  `--mem-fraction-static` 都省略，并在 `warnings` 里写明原因。
- 文案基于**判定依据**而不是「本机」：档案无 NVIDIA→「目标机器未检测到 NVIDIA 显卡」；
  `platform=darwin`→「目标平台是 Apple Silicon/macOS」；无档案本机探测→才说「控制面本机」。

修之前有个实际的错误输出：`platform=win32` + `gpus=[]` 的档案会看到
「本机是 Apple Silicon」——那是**控制面所在机器**的平台，被当成了客户端平台，
Windows 用户会看到控制面告诉他「本机是 Apple Silicon」。

### gap 7：创建时不校验后端可用性 —— 已修

`deployments.KNOWN_BACKENDS` 与前端 / 桌面端的 `ALL_BACKENDS` 对齐，
`create()` 分两种情况：

| 情况 | 行为 |
|---|---|
| 未知后端名（如 `nonsense`） | `InvalidDeploymentRequest` → 400 |
| 已知但本机探测不到（如这台 Mac 上的 vllm） | 仍创建，但 `status=BLOCKED`，日志写明「在本机不可用」 |

即：**不假装能用，也不假装没这个后端**。`_detect_backends()` 同时补齐了
mlx / llama.cpp / docker 的探测。


