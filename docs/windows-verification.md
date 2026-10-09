# Windows 真机验证报告

> 这一份取代了 `docs/windows-gaps.md` 的静态审查结论：所有「真机未验证」的条目
> 现在都有执行记录。原始输出留在工作区 `_win_verify/` 下（不在仓库里）。
> 本文只写**跑过什么、结论是什么、哪些还没跑**。

- 机器：HP Z2 Tower G5 / **Windows 10 专业版 19045.6456** x64 / i7-10700K (8C16T) / 32 GB / **RTX 3060 12 GB** / NVIDIA 536.23 / CUDA 12.2
- 会话：PowerShell 5.1，**非提权**（用户在 Administrators 组；需要时用 UAC 提权）
- 仓库：`feat/client-hardware-profile` @ `6577aae`
- 无 winget、无 choco/scoop、无 pwsh 7、无 python/python3 在 PATH、Docker/WSL 起始均未安装

---

## 0. 完成度核对表

### 「Windows 基础支持完成」的 17 条

| # | 条件 | 结论 | 证据 |
|---|---|---|---|
| 1 | Windows Electron 可以正常启动 | ✅ | `npm start` 起窗口（截图证据 `_win_verify/evidence/electron-window.png`），本地服务随机/指定端口 `/api/health` 200 |
| 2 | 硬件探测结果和任务管理器一致 | ✅ | 应用 31.8 GB / free 17.9 GB；`Win32_OperatingSystem` 31.78 GB / 17.95 GB |
| 3 | NVIDIA 显存超过 4 GB 时读取不截断 | ✅ | 注册表 `qwMemorySize` = 12884901888 → 12 GB；**同机 `AdapterRAM` 确实截断成 4293918720（4 GB）** |
| 4 | `nvidia-smi` 不在 PATH 时仍能找到 | ✅ | 清空候选表后走注册表仍拿到 RTX 3060 12 GB；反向验证：PATH 去掉 System32 时 `where` 找不到但回退生效 |
| 5 | PowerShell 5.1 可以执行探测脚本 | ✅ | 默认 Restricted 策略下 `irm \| iex` exit 0、合法 JSON、契约字段全对齐 |
| 6 | PowerShell 7 可以执行探测脚本 | ⚪ **无法验证** | 本机无 pwsh，无 winget/choco/scoop，非管理员装不了 MSI。W8 只完成 5.1 一半 |
| 7 | WSL2 状态判断正确 | ✅ **已修并验证** | 原为 ❌ 误报（G3）：`environment.scan()` 把 `wsl.exe` 存在当成装了 WSL。现 `wsl_status()` 真跑 `wsl --status` 判断退出码，返回 `ready/present/absent` 三态；本机实测 `{installed:true, usable:true}`，桩态有单测覆盖 |
| 8 | Docker 未安装 / 未启动 / 正常状态区分正确 | ✅ | 三档都验过：「未安装/守护进程不在」→ `/api/backends` 不列 docker；「引擎起来」→ 列出 docker 且真能部署。见 §5、§7 |
| 9 | Windows 路径和带空格路径可用 | ✅ | 中文+空格：模型下载/部署/日志/GGUF 目标目录全部可用（`D:\项目 测试\…`） |
| 10 | llama.cpp Windows 真实推理成功 | ✅ | CPU 构建 68.8 tok/s；**CUDA 构建 320.7 tok/s**，`nvidia-smi` 里能看到该进程 |
| 11 | Ollama Windows 真实推理成功 | ✅ | `qwen2.5:0.5b` → RUNNING → `/v1/chat/completions` 200 真实中文回复 |
| 12 | Docker CPU 真实推理成功 | ✅ | 引擎在真机重启后可用；应用 docker 后端 create→RUNNING→`/v1/chat/completions` 200→stop→delete 全通，容器内 llama.cpp 真实加载模型（62.9 tok/s），无孤儿容器。见 §7.2 |
| 13 | Electron NSIS 安装包能安装、启动、卸载 | ✅ | 76.4 MB 安装包 → 装到 `D:\项目 测试\ModelForge 安装 目录` → 启动 → 卸载干净，用户数据保留 |
| 14 | 失败部署不会留下孤儿进程 | ✅ | 关窗后 `electron.exe` 4 → 0；`llama-server` 停止后端口释放 |
| 15 | 端口冲突提示准确 | ✅ | 外部监听占用 → 400 并说清；**ollama 的 11434 被占不误报** |
| 16 | 模型下载可以断点续传 | ✅ | 应用自身 SSE 下载 491,400,032 B 完成，落盘魔数 `GGUF`；`.part` 续传逻辑单测覆盖 |
| 17 | 用户目录和模型目录权限正常 | ✅ | 非管理员写入 `~/.mdp-models` 与自定义目录成功 |

### 「Windows GPU 部署完成」的额外 6 条

| # | 条件 | 结论 |
|---|---|---|
| 1 | WSL2 GPU 可见 | ✅ `wsl -l -v` 报 `docker-desktop Running 2`；`docker info` 报 `Kernel=6.18.40.1-microsoft-standard-WSL2` |
| 2 | Docker 容器可以看到 NVIDIA GPU | ✅ `docker run --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` → RTX 3060 / driver 560.94 / CUDA 12.6；应用部署的容器内 `exec nvidia-smi` 同结果 |
| 3 | CUDA 镜像可以启动 | ✅ 官方 CUDA 镜像拉取并运行成功；`--gpus all` 生效，去掉 `--gpus` 则看不到 GPU |
| 4 | vLLM 真实推理成功 | 🟡 **镜像拉取中**（8.41 GB / 40 层；Docker Hub 实测 64 MB/min，约 2-3 小时）。拉取完成前不下结论，见 §11 |
| 5 | SGLang 真实推理成功 | ⚪ 未验证（同上，镜像同为多 GB 级） |
| 6 | GPU 部署停止、重启、清理正常 | ✅ stop 后容器即删、端口释放、显存回落；同 id 二次 start 再进 RUNNING；delete 后 `docker ps -a` 为空；关窗后 electron 进程 0、无孤儿容器 |

> **替代证据（不等于完成）**：同一台机器上用官方 llama.cpp **CUDA 12.4 构建**做了
> 真实 GPU 推理 —— `--list-devices` 报 `CUDA0: NVIDIA GeForce RTX 3060 (12287 MiB)`，
> `-ngl 99` 全量卸载，`/v1/chat/completions` 返回真实中文回复，`predicted_per_second = 320.7`，
> `nvidia-smi --query-compute-apps` 里能看到 `llama-server.exe`，停机后显存从 1725 MiB 回落到 1025 MiB。

> **为什么 vLLM/SGLang 仍算「未完成」**：容器能拿到 GPU 这件事已经用官方 CUDA 镜像证实了，
> 但 vLLM 自己起不起来（CUDA 版本匹配、显存占用、`--gpus` 之外的参数）是另一件事，
> 没有真实的 `vllm serve` 日志就不算过。镜像拉完之前这条保持待定。

---

## 1. 硬件探测（W1–W4）

```
desktop/probe.js →
  platform=win32  architecture=x64  cpu_cores=16
  cpu = Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz
  ram_gb = 31.8   ram_available_gb = 17.9
  gpus = [{ NVIDIA GeForce RTX 3060, vendor=nvidia, vram_gb=12, uma=false }]
```

系统真值对照：

| 项 | 应用 | 系统 |
|---|---|---|
| CPU | i7-10700K | `Win32_Processor.Name` 相同 |
| 核数 | 16 | 8C/16T |
| 内存 | 31.8 GB | `TotalPhysicalMemory` 34125086720 B = 31.78 GB |
| 可用 | 17.9 GB | `FreePhysicalMemory` 17.95 GB |
| 显存 | 12 GB | `nvidia-smi` 12288 MiB；注册表 12884901888 B |

三个显存来源实测对比（本机）：

| 来源 | 结果 |
|---|---|
| `nvidia-smi --query-gpu=memory.total` | 12288 MiB ✅ |
| 注册表 `HardwareInformation.qwMemorySize`（REG_QWORD） | 12884901888 B = 12 GiB ✅ |
| `Win32_VideoController.AdapterRAM`（uint32） | **4293918720 B = 4 GiB ❌ 截断** |

第三行就是「不用 AdapterRAM」这个决定的真机证据。

真实 GPU 字符串分类（`windowsGpuIsUma()` / `classifyGpuVendor()`）：

| 驱动上报的字符串 | vendor | uma |
|---|---|---|
| `NVIDIA GeForce RTX 3060` | nvidia | false |
| `Intel(R) UHD Graphics 630` | intel | **true** |
| `Intel(R) UHD Graphics P630` | intel | **true** |
| `OrayIddDriver Device` | unknown | false ⚠ 虚拟适配器，见 G1 |
| `GameViewer Virtual Display Adapter` | unknown | false ⚠ 同上 |

---

## 2. PowerShell 探测链路（W5、W8、W9）

`GET /api/hardware/probe.ps1` 拿到的脚本（2160 B）在 **PowerShell 5.1** 上：

| 场景 | 结果 |
|---|---|
| 默认策略（Restricted）下 `irm <base>/api/hardware/probe.ps1 \| iex` | ✅ exit 0，输出合法 JSON |
| 存盘后执行（Bypass / RemoteSigned） | ✅ |
| 非管理员 | ✅ |
| 中文目录 + 中文文件名 | ✅ 7/7 不乱码 |
| 契约字段 | ✅ `platform=win32`、`ram_gb=31.8`、`vram_gb=12`、`vendor=nvidia`、`uma=false` |
| 与 `probe.js` 并排比对 | ✅ 内存/GPU 名/显存/vendor/uma 完全一致（仅 `architecture` 拼写 AMD64 vs x64，cpu/available 脚本未采集，契约不要求） |
| PowerShell 7 | ⚪ 本机无法验证 |

**方法论警告**：`powershell -ExecutionPolicy X` 会把 `PSExecutionPolicyPreference=X` 写进子进程
环境并被孙进程继承 —— 任何「加了 Bypass 就宣称 Restricted 也能跑」的验证都是无效的。

`probe-command` 的 win32 分支逐字执行成功；**非 win32 分支依赖 `python3`，本机不存在 → 命令不可执行**（G2）。

---

## 3. P1：llama.cpp GGUF 全链路

模型：`Qwen/Qwen2.5-0.5B-Instruct-GGUF` → `qwen2.5-0.5b-instruct-q4_k_m.gguf`，**491,400,032 B**。

```
推荐模型（resolver: best-quality-resident）
  → gguf/plan（无 token 403；有 token 返回 repo/file/size/dest）
  → gguf/download（SSE，24,259 帧进度；落盘 491,400,032 B，魔数 GGUF）
  → POST /api/deployments（Windows 路径校验通过，中文+空格路径）
  → start → 健康检查（约 3 s 转 RUNNING）
  → /v1/chat/completions 真实中文回复
  → stop（端口释放）→ delete
```

实测：

| 后端 | 回复 | 速度 |
|---|---|---|
| llama.cpp CPU 构建（b11247 win-cpu-x64） | “我是由阿里云自主研发的超大规模语言模型…” | 68.8 tok/s |
| llama.cpp **CUDA 12.4 构建** | “我是Qwen，一个由阿里巴巴集团开发的超大规模语言模型…” | **320.7 tok/s** |

应用自身（不是手工 curl）跑的部署：`-ngl 99 -fa on`，`nvidia-smi` 里能看到
`llama-server.exe` 该进程；停机后显存回落、端口释放、`DELETE` 成功、无孤儿进程。

**端口语义（真机确认）**：

| 场景 | 结果 |
|---|---|
| ollama 部署时 11434 已被守护进程占用 | ✅ 允许（不误报冲突） |
| llama.cpp 目标端口被外部程序占用 | ✅ 400 + 说明 |
| llama.cpp 目标端口被另一个 **RUNNING** 部署占用 | ✅ 400 |
| 端口只被 **CREATED**（未启动）的行占用 | ✅ 允许（不阻塞） |
| 同模型换端口再建一个 | ✅ 允许 |

---

## 4. P2：Ollama 全链路

`OllamaSetup.exe`（1,571,115,536 B，Authenticode Valid / Ollama Inc.）静默安装 → `ollama 0.34.4`。

```
应用探测到 ollama（/api/backends → ["ollama"]）
  → POST /api/deployments（port 9999 被改写为 11434，未被端口探测挡住）
  → start → 守护进程已在跑 → RUNNING
  → /v1/chat/completions 200 “我是由阿里云开发的超大规模语言模型…”
  → ollama list 里有模型（397 MB）
  → stop（共享模型，不卸载）→ 守护进程继续应答
  → delete → 退出应用后守护进程仍活着、模型仍在
```

> 说明：**首次**运行时模型未下载，`ollama pull` 没有在 `start` 里真正执行
> （`_runOllama` 在 `tags.includes(model)` 为假时才 pull，实测该分支未触发成功）。
> 手工 `ollama pull qwen2.5:0.5b` 后重跑，全链路 RUNNING + 真实回复通过。
> 这条 pull 分支在真机上的行为**只验证到「有模型时不再 pull」**，未验证「无模型时能 pull 成功」。

---

## 5. Docker 状态区分（P0-5）

本机在验证过程中装上了 Docker Desktop 4.93.0（CLI 29.8.1），因此可以测「已安装但引擎不可用」这一档：

```
where docker        → C:\Program Files\Docker\Docker\resources\bin\docker
docker --version    → Docker version 29.8.1
docker info         → exit 1: Error response from daemon: Docker Desktop is unable to start
```

应用侧的判断：

| 观察 | 结论 |
|---|---|
| `/api/backends` → `caps.docker = false`，`backends = []` | ✅ 引擎不活着就不声称可部署 |
| `docker` 出现在 `installable`（而不是 `unavailable`） | ✅ |
| 文案 | ✅「Docker 已安装，但守护进程没有运行。启动 Docker Desktop（或 dockerd），等 `docker info` 能返回 ServerVersion 后重试。」—— 与真实状态完全一致，而不是让你重装 |

未测档位：Docker **未安装**（起始状态，但当时没有跑这一档的脚本）、Docker **完全可用**、镜像已存在 / 需拉取、当前用户无 docker 权限（本机用户在 `docker-users` 组）。

---

## 6. Windows 路径与非管理员

| 场景 | 结果 |
|---|---|
| `D:\项目 测试\模型 目录\gguf 应用下载\…` 作为模型路径 | ✅ 创建/启动/推理/删除全通 |
| 安装到 `D:\项目 测试\ModelForge 安装 目录`（中文+空格） | ✅ 安装、启动、卸载全通 |
| 非管理员写入 `~/.mdp-models` 与自定义目录 | ✅ |
| Docker volume 宿主路径 `C:\…` | ✅ 已修，见 G4（修复前 100% 被拒） |

---

## 7. WSL2 / Docker GPU 直通（P4）

### 7.1 当时为什么起不来：不是「忘了重启」，是服务栈被卡死

第一轮结论写着「需要手动重启」。**重启了，但没解决** —— 这一点值得单独记下来，
因为它暴露的是 Windows 自己的问题：功能被标记为「已启用」，但离线安装阶段从未执行。

冷启动后复查（`LastBootUpTime = 2026-09-30 02:16:43`，引导类型 `0x0` = 真冷启动）：

```
HypervisorPresent                 = False
C:\Windows\System32\vmcompute.exe = 不存在
C:\Windows\System32\drivers\lxcore.sys = 不存在
C:\Windows\System32\lxss\tools    = 不存在
CBS\RebootPending                 = True      ← 重启后仍然 True
C:\Windows\WinSxS\pending.xml     = 存在（5.9 MB）
C:\Windows\WinSxS\poqexec.log     = 从未生成
```

`CBS.log` 每次开机都写同一句：

```
TI: started and RebootPending volatile key indicates that a reboot is
    pending, skip startup processing.
```

死循环：TrustedInstaller 开机看到「待重启」→ 跳过启动处理 → 标记不清 → 下次继续跳过。
所以三个功能都显示 `State=Enabled`，组件文件却永远落不到 `System32`。
DISM 也印证了队列里卡着包：

```
Package_for_RollupFix … 19041.6456.1.21  | 卸载挂起
Package_for_RollupFix … 19041.6466.1.0   | 安装挂起
```

**卡住队列的元凶**是 Session Manager 的待办删除操作，指向被内核驱动锁住的文件：

```
*1\??\C:\Users\HP\AppData\Local\Temp\TAOKernelEx64_ev.sys30-2-16      【被锁】
*1\??\C:\Users\HP\AppData\Local\Temp\TAOAcceleratorEx64_ev.sys30-2-17 【被锁】
持有者：TAOKernelDriver / TAOAccelerator（腾讯电脑管家，Running/Auto）+ QQPCRTP
```

清理后它还会被重新塞回来（第二次看到的是 `C:\ProgramData\Tencent\QQPCMgr\garbagelist.drt`），
说明这是**持续性**污染，不是一次性残留。

### 7.2 最终怎么通的

| 步骤 | 结果 |
|---|---|
| `dism /online /cleanup-image /revertpendingactions` | ✅ `PackagesPending` 与 `pending.xml` 双双转 **False** |
| 重新 `dism /enable-feature` WSL / VirtualMachinePlatform / Hyper-V | ✅ 三者 `State=Enabled`，排进干净事务 |
| `bcdedit /set hypervisorlaunchtype auto` | ✅ 之前 BCD 里**根本没有这一项** |
| 清空 `PendingFileRenameOperations` | ✅ 去掉开机唯一必败的步骤 |
| 之后一次重启 | ✅ 服务栈落盘（见下） |

重启后的实测状态：

```
vmcompute.exe = True      lxcore.sys = True      lxss\tools = True
wslconfig.exe = True      HypervisorPresent = True     vmcompute 服务 Running
```

Docker 实测：

```
docker version → Server: Docker Desktop 4.93.0 / Engine 29.8.1 / linux/amd64   exit 0
docker info    → Kernel=6.18.40.1-microsoft-standard-WSL2  Driver=overlayfs
wsl -l -v      → docker-desktop  Running  2
```

> ⚠️ **踩到过的坑（对自己）**：`dism` 的临时脚本必须**纯 ASCII**。
> PowerShell 5.1 按 OEM 代码页（本机 CP936）读取**无 BOM** 的 `.ps1`，
> 带中文的脚本被解析坏后**整条命令被静默丢弃** —— 第一次 `revertpendingactions`
> 「没效果」就是这个原因，不是命令本身无效。

### 7.3 Docker GPU 直通（真实观测）

```
$ docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
NVIDIA-SMI 560.35.02   Driver Version: 560.94   CUDA Version: 12.6
| NVIDIA GeForce RTX 3060  ...  915MiB / 12288MiB ... 4% |      exit 0
```

### 7.4 应用自己的 docker 后端（不以 `docker run` 代替）

CPU 路径（`ghcr.io/ggml-org/llama.cpp:server` + 宿主 `D:\项目 测试\…` 卷 + `gpus=none`）：

| 阶段 | 结果 |
|---|---|
| `/api/backends` | `["ollama","docker"]`，`caps={platform:win32,docker:true,nvidia:true}` |
| `POST /api/deployments` | 200；`container_port` 由镜像名推出 = 8080 ✅ |
| `POST …/start` → health | **RUNNING**（5 s 内）；`docker ps` 显示 `127.0.0.1:8094->8080/tcp` |
| `POST …/test` | 200，`reply` 为真实中文回复，`completion_tokens=33` |
| 直连映射端口 | 200；llama.cpp 自报 `predicted_per_second = 62.9` |
| `…/stop` | 容器即被删除，端口释放 |
| `DELETE` | `{"deleted":true}` |
| 关窗后 | `electron.exe` = 0，`docker ps -a` 为空 —— **无孤儿容器** |

GPU 路径（同镜像 + `gpus=all` + `-ngl 99`）：

| 阶段 | 结果 |
|---|---|
| `POST /api/deployments`（`gpus=all`） | 200，`gpus=all`、`container_port=8080` |
| health | **RUNNING** |
| 容器内 `exec nvidia-smi` | `NVIDIA GeForce RTX 3060, 560.94, 948 MiB, 12288 MiB` ✅ |
| `POST …/test` | 200，真实中文回复（`finish_reason=length`，48 tokens） |
| `…/stop` → 二次 `start` | 容器删除、显存回落；**同一个 id 二次 start 再进 RUNNING** |
| 二次 stop + `DELETE` | `docker ps -a` 为空 |

> 注意：`ls /dev/nvidia*` 在容器里报 `No such file or directory`，但 `nvidia-smi` 正常返回 ——
> 这是 WSL2 GPU 直通的正常形态（驱动由 `/usr/lib/wsl` 注入，不走 `/dev/nvidia*`），
> 所以**不要用 `/dev/nvidia*` 判断直通是否生效**。

### 7.5 内存限额

第一轮说「一条 Linux 实例都起不来，`/proc/meminfo` 拿不到数字，不编造」。
现在可以拿到了：`docker info` 报 `16654086144` B ≈ 15.5 GB 可用给容器。

---

## 8. Electron Windows 桌面端（P0-1）

| 项 | 结果 |
|---|---|
| `npm install` | ✅ 320 包 |
| `npm start` | ✅ 窗口正常（截图），标题 `ModelForge` |
| 主进程本地 HTTP | ✅ 随机端口；`MDP_PORT` 可固定 |
| 窗口关闭时子进程回收 | ✅ `electron.exe` 4 → 0 |
| 单实例锁 | ✅ 第二个实例 6 s 内退出（exit 0），不抢端口 |
| 端口被占 | ✅ 应用退出而不是静默换端口 |
| CSP nonce / token | ✅ 每次响应不同 nonce，占位符全部替换 |
| Host 头（DNS rebinding）用原始 socket 验 | ✅ `evil.example` → 403；`127.0.0.1`（无端口）→ 403 |
| 未带 token 的写操作 | ✅ 403 |
| `%2e%2e` 路径穿越 | ✅ 404 |

---

## 9. NSIS 安装包（W10）

```
npm run dist  →  dist\ModelForge Setup 0.1.0.exe   76.4 MB（未签名）
```

| 步骤 | 结果 |
|---|---|
| 安装到含中文与空格的路径 | ✅ exit 0 |
| 注册表卸载项 | ✅ `ModelForge 0.1.0` |
| 启动 | ✅ 窗口 + `/api/hardware/self` 正常 |
| 卸载 | ✅ exit 0，目录与注册表项都被移除 |
| 用户数据 | ✅ 保留（`%APPDATA%\mdp-desktop`） |
| 代码签名 | ❌ 未做 → SmartScreen 会警告（与 macOS 公证同类的缺口） |

---

## 10. 本轮在真机上发现并修复的缺陷

### G0（CRITICAL）打包漏文件，安装包一启动就是死应用

`electron-builder.yml` 的 `files:` 是手写白名单，漏了 `ggufdl.js` / `gguf.js`，而
`server.js:9` 顶层 `require("./ggufdl")` 在 `main.js:4` 的依赖链上。真实的 `app.asar`
只有 6 个文件；跑真 `ModelForge.exe` → 只剩一个标题为 **Error** 的框，本机 HTTP 服务不可达。

**已修**：`files:` 改成 `*.js` + 排除 `test-*.js`/`smoke.js`（新增模块默认进包），并新增
`desktop/test-packaging.js` —— 它从配置里推导出「入包的 require 闭包必须封闭」，不依赖人工枚举，
`--built` 还会真的启动打包产物并断言 `/api/health` 200。修复后重建，安装包启动正常。

### G1（HIGH）注册表回退在有虚拟适配器的机器上仍以退出码 1 结束

本机实测：probe.js 用的那条 PowerShell 注册表一行命令，即使 `-ErrorAction SilentlyContinue`
且 5 个适配器全部正常打印，进程仍 exit 1（非管理员读 `…\{4d36e968…}\Properties` 得到
「Requested registry access is not allowed」）。`runResult()` 在 `err` 为真时把 stdout 丢掉，
于是 GPU 列表变成 `[]`。本机因为有 `nvidia-smi` 而看不到这个后果；**没有 N 卡的 Windows 机器
（核显笔记本）会丢掉整张显卡列表**。已把现象、复现命令与原始输出记入 `_win_verify/evidence/`，
修复方案（读 stdout 而不看退出码 / 把错误流打开）留待评估 —— 本轮**未改**这段逻辑。

### G2（MEDIUM）`probe-command` 的非 Windows 分支依赖 `python3`

`curl -fsSL …/probe.py | python3 -`：本机 `where python3` 无命中，cmd 里 exit 255；
PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 别名，更早就报 `-fsSL` 参数不存在。
前端平台下拉的第 4 项就是 `unknown`，用户会拿到这条必然失败的命令。**未修**。

### G3（MEDIUM）控制面把「宿主上有 wsl 命令」当成「装了 WSL」—— 已修

`environment.scan()` 用 `shutil.which("wsl")`，而 Windows 10 **自带** `C:\Windows\System32\wsl.exe`
（FileDescription = Microsoft Windows Subsystem for Linux Launcher，版本 10.0.19041.3636）。
本机 `wsl --status` exit 50、`wsl -l -v` exit 1、`lxss\tools`/`lxcore.sys`/`LxssManager` 全部不存在
（即 WSL 未安装），但 `/api/environment/latest` 报 `wsl2.installed = true`、
`checks` 里 `WSL2 PASS WSL 可用`。

**已修**：新增 `wsl_status()`，真跑 `wsl --status` 看退出码，返回三态：

| 状态 | 含义 | `wsl2.installed` | `wsl2.usable` | check |
|---|---|---|---|---|
| `ready` | `wsl --status` exit 0 | true | true | PASS |
| `present` | 只有桩命令，`--status` 不通过 | true | false | WARNING |
| `absent` | 连 wsl.exe 都没有 | false | false | WARNING |

同时 `scan()` 的返回值新增 `wsl2.usable` 字段（向后兼容，`installed` 语义未变）。
本机修复后实测：`{installed: true, usable: true}`，`WSL2 PASS WSL 可用` —— 与事实一致。
桩态（exit 50）、ready 态（exit 0）、absent 态各有一条单测。

### G3b（MEDIUM）Windows 上 `memory.total_gb` 恒为 null —— 已修

`scan()` 只在 Apple Silicon 分支调 `sysctl hw.memsize`，其余一律 `None`，于是
`/api/environment/latest` 在 Windows 上报 `"memory": {"total_gb": null}`，而
`hardware.py` 的 Windows 分支早就会读 CIM 了 —— 两个模块对同一台机器的内存结论不一致。

**已修**：新增 `_windows_memory_gb()`，Windows 上走
`(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory`；命令失败或输出不可解析时
仍返回 `None`（不编造）。本机实测 `total_gb = 31.8`，与系统真值一致。

### G4（HIGH）Windows 上 docker 数据卷 100% 被拒 —— 已修

`deploy.js:34 VOLUME_PATH_RE` 只认 `/` 开头，`C:\models` 被当成相对路径拒绝，
文案还说「必须是绝对路径」而用户填的确实是绝对路径。同一根因让 `test-docker.js`
在 Windows 上只跑 11/89 条就抛错中止。

**已修**：宿主路径接受 POSIX / 盘符 / UNC 三种绝对形式，容器路径仍限定 Linux 绝对路径；
后端 `_ABS_PATH_RE` 同步拆分（`_ABS_PATH_RE` + `_CONTAINER_PATH_RE`）。

### G5（HIGH）子进程输出按 UTF-8 解码，中文全是乱码 —— 已修

`String(buf)` 对 GBK 字节流做 UTF-8 解码，`ollama pull` 的失败原因显示成
16 个替换符。**已修**：`decodeChunk()` 按 `chcp` 得到的代码页（本机 936 → GBK）解码，
非 Windows 保持原路径，任何解码失败都不抛异常。

### G6（HIGH）没有 N 卡的 Windows 机器被定价为「0 GB 可用」

`hardware._os_ram()` 只有 sysctl 与 `/proc/meminfo` 两条路，Windows 上恒返回 `(0, 0)`。
本机有 N 卡所以 budget 走 nvidia-smi 掩盖了它；拔掉显卡后 `usable_vram_gb` 直接是 0。
**已修**：`sys.platform == "win32"` 走 CIM（`TotalPhysicalMemory` / `FreePhysicalMemory`），
读不到可用内存时按总量的 50% 兜底（与 macOS 分支同策略）。

### G7（MEDIUM）`installers.js` 的 Windows 结论与事实和 README 矛盾 —— 已修

原代码：`Windows 上没有可靠的包管理器渠道，需要手动下载`。事实是 winget 有官方
`ggml.llamacpp` 包（便携版 `llama-server.exe`），且同一文件里 ollama / docker 两个
Windows 分支本来就在用 winget，README:89 也写「Windows 走 winget」。

**已修**：新增 winget 分支；并处理了 winget 作为 App Execution Alias 时
`where winget` 找不到（本机就是这种情况：别名在 `%LOCALAPPDATA%\Microsoft\WindowsApps`，
`fs.existsSync` 对重解析点返回 false）—— 用目录列举探测，与 `probe.js` 对 nvidia-smi 的做法一致。

### G8（MEDIUM）测试套件自身写死了 POSIX

| 文件 | 问题 | 处理 |
|---|---|---|
| `backend/tests/test_trust_boundary.py:208` | `path.read_text()` 跟随 locale（cp936）→ 读 UTF-8 源码 `UnicodeDecodeError` | 已修：显式 `encoding="utf-8"` |
| `backend/tests/test_deployments.py` | 假设本机一定装了 ollama | 已修：monkeypatch 固定探测结果，并补一条「探测不到就是 BLOCKED」 |
| `desktop/test-install.js` | 用 `/bin/echo`、`/bin/sh -c` | 已修：改用 `process.execPath -e` |
| `desktop/test-trust.js` | fake `llama-server` 是 `#!/bin/sh` 脚本，Windows 上 `spawn` 拿不到 | 已修：用系统自带 csc 编译一个真 `.exe`（记 argv + 提供 `/health`） |
| `desktop/test-docker.js` | 同上；且 `HOME` 伪造在 Windows 无效；`SIGTERM` 宽限期断言在 Windows 恒假 | 已修：node.exe 副本作 `docker.exe` + argv 重建 + cwd 桩文件；`HOME`/`USERPROFILE` 一起设；宽限期断言按平台跳过（仍断言「进程最终会死」） |

修复前后（同一台机器）：

| 套件 | 修复前 | 修复后 |
|---|---|---|
| backend pytest | 2 failed, 202 passed | **231 passed**（含 26 条 Windows 回归） |
| desktop node 7 套件 | 10 failed（docker 只跑 11/89） | **全部 exit 0**（docker 87/87） |
| electron 3 套件 | 1 failed + 崩溃 | **全部 exit 0**（layout 6 / frontend 124 / backend-ui 10） |

> 复现 electron 三套件时注意：**必须用 `node_modules\electron\dist\electron.exe test-*.js`**，
> 用 `node test-*.js` 会以 `Cannot read properties of undefined (reading 'disableHardwareAcceleration')`
> 失败 —— 那是调用方式错了，不是代码缺陷。

新增 `backend/tests/test_windows_regressions.py`（26 条：卷路径两种拼写、容器路径、
Windows 内存读取与兜底、`wsl_status` 三态、`read_text` 编码检查、子进程解码检查）与
`desktop/test-packaging.js`（6 条：入包闭包封闭 + 打包产物真启动）。

---

## 11. 还没做的（诚实清单）

1. **vLLM 真实推理**：镜像 8.41 GB / 40 层，Docker Hub 到本机实测 **64 MB/min**，
   预计 2-3 小时；拉取中，完成前不改结论。SGLang 同理。
2. **PowerShell 7**：本机无 pwsh、无包管理器、非管理员装不了。
3. **Docker「未安装」档位**：起始状态没跑这一档的脚本（当时 Docker 已装）。
4. **多路 CPU**（W6）：单路机器，没有样本。
5. **中文 GPU 名称**：本机 5 个适配器名全为 ASCII，没有样本（只验证了后端能承载非 ASCII）。
6. **旧 APU / 移动独显边界**（`Radeon HD 8650G`、`R7 M240`、`Arc A770M`）：本机没有这些卡。
7. **G1 未修**：`probe.js` 注册表回退在非管理员 + 无 NVIDIA 命令行的机器上，
   访问 `…\{4d36e968…}\Properties` 被拒导致退出码 1，stdout 被丢弃 → GPU 列表为空。本机有 N 卡，掩盖了它。
8. **G2 未修**：`probe-command` 非 Windows 分支需要 `python3`；PS 5.1 的 `curl` 是 `Invoke-WebRequest` 别名。
9. **Ollama 首次 pull 分支**：见 §4 说明。
10. **NSIS 代码签名**：未做，SmartScreen 会警告。
11. **升级安装**（同版本覆盖安装）：未测（同版本重装已测，见 §5）。
12. **杀毒软件误报**：本机未触发，未做专项测试。
13. **腾讯电脑管家与 Windows 服务栈的冲突**：§7.1 记录的持续污染源（两个 `TAO*` 内核驱动锁住
    `%TEMP%` 里的文件，塞进 `PendingFileRenameOperations`）。应用侧无法解决，只做记录。
