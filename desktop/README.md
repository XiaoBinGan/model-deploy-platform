# mdp-desktop

Electron 桌面端。窗口加载的页面与本地 API **同源**，
所以没有 CORS、没有 Private Network Access 预检、没有混合内容问题。

桌面端在同一份页面上补了三件事：本机探测、本机部署、把项目名写进标题栏。

## 界面

单页。没有侧边栏、没有分页导航，高级项折叠在底部。

- 项目名在 **Electron 标题栏**，页面里没有品牌头部
- `nativeTheme.themeSource = "dark"`，标题栏跟随深色，不会在深色页面上压一条浅色
- 背景纯色 `#0b0d10`，没有顶部渐变，也没有单独的横幅条
- 折叠项：预算与警告 / 全部候选模型 / 硬件档案 / 环境检测
- 硬件信息收成一行四格，不再占四张大卡片

浏览器直接访问控制面时看到的是同一份页面。

### 自适应布局

页面跟着窗口走，宽度在 1440px 封顶。改之前 `main` 是 `max-width:900px`，
窗口拉大内容不动：

| 窗口 | 改前内容宽 | 占比 | 改后内容宽 | 占比 |
|---|---|---|---|---|
| 1080（默认） | 900 | 83% | 1080 | 100% |
| 1280 | 900 | 70% | 1280 | 100% |
| 1440 | 900 | 63% | 1440 | 100% |
| 1728（16 寸满屏） | 900 | **52%** | 1440 | 83% |
| 2560 | 900 | **35%** | 1440 | 56% |

**为什么封顶 1440**：日志和表格越宽越好，但硬件格和输入框不是——
2560 全宽会让每个格子摊到 620px、输入框摊到 2500px。1440 是两者的平衡点，
也是 16 寸满屏能拿到 83% 的地方。

高度上也做了处理：日志面板用 `max-height:min(48vh,460px)` 在面板内部滚动，
而不是把页面撑到几千像素。

**四个硬件格用显式断点（4 / 2x2 / 1），不用 `auto-fit`。**
格子数量固定是 4，而 `auto-fit` 在 720px（窗口最小宽度）会排出 3 列，
第四个格子单独掉到第二行。这个退步只有量出来才看得见。

```bash
npm run test:layout
```

`test-layout.js` 用真 Electron 窗口从 720 扫到 2600（步长 40，外加 1728/1512/2560），
逐个宽度断言：无横向滚动、无元素越界、格子行不落单、格子不小于 150px、
输入框不小于 180px。当前 50 个宽度全部通过。

它需要控制面在跑：

```bash
cd backend && .venv/bin/python -m uvicorn app.main:app --port 8790
cd desktop && npm run test:layout
```

## 跑起来

```bash
cd desktop
npm install
npm start
```

内网自用**不需要**签名、不需要 electron-builder、不需要 PyInstaller。

## 探测：读浏览器读不到的东西

| 平台 | 手段 |
|---|---|
| macOS | `sysctl hw.memsize` / `vm_stat` / `system_profiler` |
| Windows | 注册表 `HardwareInformation.qwMemorySize`（REG_QWORD）/ CIM |
| Linux | `nvidia-smi` / `/proc/meminfo` |

Windows 特意避开 `Win32_VideoController.AdapterRAM`——它是 uint32，
12GB 显卡会被截断成 4GB。

## 部署：在本机执行，不在控制面

| 后端 | 行为 |
|---|---|
| ollama | 缺模型先 `ollama pull`，再 `keep_alive` 常驻；停止时卸载 |
| llama.cpp | 带本机硬件向控制面要规划，spawn `llama-server`，轮询 `/health` |
| mlx | Apple Silicon 的高吞吐路径，见下 |
| vLLM / SGLang | 明确 `BLOCKED`：vLLM 官方只发 manylinux 的 x86_64/aarch64 wheel，没有 macOS 版本，源码包依赖 CUDA/ROCm 内核 |
| transformers | 控制面**有**实现（`app/runtimes/transformers_server.py`），但那个 runtime 模块在服务端代码里，桌面端本地跑不了，所以这里也是 BLOCKED |

### 缺的后端可以直接点着装

下拉里不可用的后端**不是禁用的**，点一下会弹框说明缺什么，能装的话给一个「确认安装」。

禁用一个 `<option>` 看起来更安全，但浏览器不会给禁用的选项发点击事件，用户只能盯着
「本机未安装」四个字，没有任何出路。

点击后下拉立刻回退到可用的后端，再弹框——所以下拉永远不会停在一个跑不了的后端上。

弹框分三种：

| 情况 | 下拉里的文案 | 表现 |
|---|---|---|
| 可安装 | 未安装，可一键安装 | 列出将要执行的每一步 + 等价命令，给「确认安装」和「复制命令」 |
| 平台装不了 | 本机装不了 | 只说原因，**不给安装按钮** |
| app 跑不了 | 桌面端跑不了 | 说清楚装什么都解决不了，要换台机器 |
| 浏览器直连控制面 | 本机装不了 | 说明安装只能在桌面端做 |

后两类必须分开。「本机装不了」是 *这台机器没有*，装点东西能解决；
「桌面端跑不了」是 *这个 app 不能跑它*（transformers 的 runtime 在服务端代码里），
装什么都解决不了。混在一起会让人去装一个装了也没用的包。

平台判断里还要说清楚 Docker 到底行不行，因为用户一定会问：vLLM / SGLang 在 macOS
上 **Docker 也不行**——Docker Desktop 的 GPU 支持只在 Windows 的 WSL2 后端提供，
macOS 上容器拿不到 GPU。Windows 上 Docker + WSL2 是可行路径（WSL2 没有 edition
限制，家庭版也能装），但要有 NVIDIA 显卡。

**为什么有些后端不给安装按钮**：vLLM / SGLang 官方只发 manylinux 的 x86_64 / aarch64
wheel，没有 macOS 版本；transformers 的 runtime 在服务端代码里。给一个点了必然失败的
按钮，比直接说清楚更糟。

安装过程用 **SSE 流式输出**，每一步的命令和输出都实时显示——让用户看见自己机器上在发生
什么，这是「帮你装」能被接受的前提。命令**本地构造**（同 argv 那条规则），
每一步是 argv 数组、不经过 shell。

```bash
node test-install.js        # 安装计划与 SSE 管道（不会真装东西）
npm run test:ui             # 真窗口里点下拉、验证弹框与回退
```

### 控制面是提示源，不是命令源

llama.cpp 那条会向控制面要规划，而 `/api/plans/preview` 返回的是一个**拼好的 argv**。
修前它被原样 spawn——控制面无鉴权，谁能应答那个地址，谁就能在这台机器上执行任意命令。

现在只取**一个整数**（上下文窗口），argv 一律本地拼：

```js
const window = safeWindow(data.decision.planned_window);  // 1024..1048576，否则丢弃
const argv = this._llamaArgv(item, window);               // 本地拼
```

顺带：警告里的换行会被压平（否则能伪造日志行），端口加了 1024~65535 校验。

```bash
node test-trust.js
```

`test-trust.js` 起一个**敌对服务**，返回 `command: ["<evil.sh>"]`，
断言脚本从未被执行、argv 是本地拼的、但服务给的窗口仍然生效。
完整设计见 docs/trust-boundary.md。

## MLX：Apple Silicon 上真正对标 vLLM 的东西

在 Mac 上想要 vLLM 那种吞吐，对应的不是 vLLM，是 MLX。

```bash
python3 -m venv ~/.mdp-mlx
~/.mdp-mlx/bin/pip install mlx-lm
```

**必须用 venv**：Homebrew 和多数发行版的 Python 都受 PEP 668 管控，
直接 `pip install` 会被拒绝。桌面端探测顺序是
`$MDP_MLX_PYTHON` → `~/.mdp-mlx/bin/python3` → `python3` → `python`，
所以上面这个默认位置开箱即用；装在别处就设 `MDP_MLX_PYTHON`。

装好后桌面端会自动探测到 `mlx` 后端（检查 `python3 -c "import mlx_lm"`）。
启动命令等价于：

```bash
python3 -m mlx_lm server --model mlx-community/Qwen3-8B-4bit \
  --host 127.0.0.1 --port 8931
```

模型用 `mlx-community` 的 4bit 权重（HuggingFace 仓库 id，不是本地路径）。
catalog 里 22 个条目都有对应的 `mlx-community/*-4bit` 仓库，由 HuggingFace id
按约定推导（见 `catalog.mlx_repo()`），并有一条 network 测试对着 Hub 校验。

### 三个实测出来的坑

真装 mlx-lm 跑通之后才发现的，都已在代码里处理：

**1. `python -m mlx_lm.server` 已废弃。**
0.31.3 会打印废弃提示，指向 `python -m mlx_lm server`。现在用的是后者。

**2. `--kv-bits` 在已发布的 0.31.3 里根本不存在。**
它只在 GitHub main 上，还没发版。传进去会直接 `unrecognized arguments` 退出码 2，
整个部署起不来。所以启动前会跑一次 `--help` 问版本，只在支持时才传；
不支持就记一条日志说明 KV 走全精度。这个标志对应项目一直承诺的 `q8_0` KV 量化——
统一内存上，正是 KV 量化让 64K 上下文变得负担得起。

**3. `/health` 返回 200 不等于模型能用。**
`mlx_lm.server` 先绑端口再加载权重，`ModelProvider` 是**按需加载**的
（"Load models on demand"），`/health` 只反映生成线程是否存活。
实测：0.5B 模型从启动到能回答用了 **382 秒**（含下载），而 `/health` 在 3 秒内就 200 了。
如果直接据此报 RUNNING，用户第一条消息必然超时。

所以健康检查通过后会再做一次 **warmup**（一 token 的补全请求）强制触发加载，
加载完才标记 RUNNING。客户端的 warmup 超时会让服务端写响应时断管，
产生一堆 `BrokenPipeError` traceback，属于自造噪声，已从日志里过滤。

### 测试

不需要真装 mlx-lm 就能跑这条路径：

```bash
node test-mlx.js
```

它造一个假的 `python3`，回应 `import mlx_lm`、按需返回两种 `--help`（有/无
`--kv-bits`），并起一个真的 HTTP 服务模拟「先监听、后加载」。15 项覆盖探测、
版本门控、启动、warmup 时序、健康检查、停止杀进程、venv 发现。

## 路由

本地实现：

- `GET  /api/hardware/self` 本机实测
- `GET  /api/backends` 本机后端探测
- `GET  /api/deployments` 本机部署列表（持久化到 userData）
- `POST /api/deployments` 在本机创建
- `POST /api/deployments/{id}/start` / `stop`
- `GET  /api/deployments/{id}/health`
- `POST /api/deployments/{id}/test` OpenAI 兼容 chat

注入本机硬件后转发：

- `POST /api/plans/preview`
- `POST /api/models/recommend`

其余 `/api/*` 原样转发给控制面。

## 控制面地址

默认 `http://127.0.0.1:8790`：

```bash
MDP_SERVICE=http://100.100.182.242:8790 npm start
```

## 验证

```bash
node smoke.js                     # 12 项，不需要 Electron
node smoke.js --ollama qwen3:8b   # 额外真机加载 + 对话 + 卸载
```

## 思考型模型（qwen3 / deepseek-r1）

这类模型会先产出一段思考，放在 `message.reasoning`，然后才是 `message.content`。
如果 `max_tokens` 太小，预算会在**思考阶段**耗尽，`content` 返回空字符串——
HTTP 200、`ok: true`，但看起来像部署坏了。

实测数据（qwen3:8b，同一句话）：

| max_tokens | 结果 |
|---|---|
| 128（旧默认） | 空白 |
| 256 | 时好时坏，取决于思考长度 |
| 512 | 正常，约 200-290 completion tokens |

所以服务测试页默认改成 **512**，并且：

- `content` 为空时回退显示 `reasoning`，并标记「来自思考内容」
- `finish_reason: length` 时给出明确提示，而不是静默返回空白

**注意**：ollama 的 OpenAI 兼容端点**不认** `think: false`。
实测加上它反而让 `finish_reason` 变成 `length` 且内容为空，所以不要用它。
要缩短思考只能调大预算。

## 已知限制

- llama.cpp 需要本机 `.gguf` 文件路径；HuggingFace 仓库 id 不能直接启动
- 部署记录存在 app userData 目录；重启后旧进程状态标记为 STOPPED
- Windows 未签名首次运行会有 SmartScreen 提示
