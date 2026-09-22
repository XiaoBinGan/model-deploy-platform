# 本机探测文件与回传设计（检测会话）

> 状态：设计稿（未实现）。前置文档：`docs/client-hardware-detection.md`。
> 目标：把 T3「本地探测」从「跑命令 + 手动粘贴」升级为「点一下 → 下载 → 自动回传 → 直接出推荐」。
> 分支：`feat/client-hardware-profile`（未合并）。

---

## 0. 结论摘要

- 「下载检测文件」方向正确，是唯一能拿到**真实显存与内存**的路径。
- 「加密传输」要先定义威胁模型。在**只做推荐**的前提下，硬件档案不是秘密，
  真正的风险是**完整性**与**重放**，而不是机密性。
  正确组合是 **HTTPS 保证机密性 + 一次性 token 保证绑定与重放控制 + HMAC 保证防篡改**，
  而不是「把密钥和密文放进同一个下载文件」。
- 「回传后部署」必须拆开：一次性探测**不能**带来远端部署能力，
  远端部署需要**常驻本地助手**。这是两个不同的产物。
- 建议长期再补一条**隐私优先**路径：把 resolver 放到本机运行，
  硬件**根本不出本机**，从源头消掉加密问题。
- 立刻收益最大的一步不是新功能，而是修一个**误导性标签**（第 1 节）。

---

## 1. 先修一个误会：`独立显存 · unknown` 不是显存未知

用户实际看到：

```
设备
ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) ..., D3D11)
独立显存 · unknown
可用预算 10 GB
总容量 12 GB
```

`frontend/index.html:319`：

```js
document.getElementById('hw-type').textContent =
  (h.uma ? '统一内存' : '独立显存') + ' · ' + (rec.normalized_profile.architecture || '');
```

第二个字段是 **CPU 架构**（`architecture`），不是显存。
`backend/app/services/hardware.py:228` 把它归一化为 `unknown`，于是渲染成
「独立显存 · unknown」——读起来像「显存未知」，
但显存其实**已经通过查表得到 12 GB**，就显示在下一行 `总容量 12 GB`。

验证：`gpu_table.lookup("...RTX 3060...")` 命中 `("rtx 3060", "nvidia", 12, False)`，
`usable = 12 - max(2, 12 * 0.09) = 10 GB`。**整条链路是对的**，错的只是文案。

要改的是信息架构：

- 设备类型与显存放一行：`独立显存 · 12 GB（按型号查表，待确认）`
- CPU 架构单独一行；没有值就**不渲染**，不要显示 `unknown`
- 给查表结果一个「不对？改」入口，直接跳到硬件档案表单

这条不依赖任何新架构，可以立刻合入。

---

## 2. 拆解你的方案

| 你的设想 | 评价 | 调整 |
|---|---|---|
| 点检测 → 下载检测文件 | 正确，是唯一精确路径 | 文件按**会话生成**，内嵌回调地址与一次性 token；按 OS 给不同脚本 |
| 检测结果**加密**传输 | 目标对，实现容易变成安全剧场 | HTTPS 做机密性；token + HMAC 做绑定与防篡改 |
| 服务端做推荐 | 正确 | 增加「实测值 vs 查表值」交叉验证 |
| 服务端做**部署** | 对远端用户不成立 | 一次性探测不能部署；远端部署要常驻本地助手 |

---

## 3. 威胁模型：加密到底防谁

先把「谁在攻击、能得到什么」写清楚，否则加密没有判据。

| 威胁 | 是否真实 | 后果 | 对策 |
|---|---|---|---|
| 局域网被动嗅探硬件档案 | 是（服务为 HTTP 时） | 泄露 GPU 型号 / 内存 / 可选的主机名 | HTTPS；或默认只上报容量数字 |
| 中间人篡改档案（12G 改成 24G） | 是 | 只坑到该用户自己（推荐不准） | HMAC 签名 + 交叉验证 |
| 重放他人 token 提交伪造档案 | 是 | 同上 | nonce 一次性 + TTL + 限流 |
| 伪造「档案码」分享给他人 | 是 | 他人被误导 | 档案码用服务端密钥签名（现有 `mdp1` 只有校验和，防不了伪造） |
| 远端用户让服务器替他部署 | 是（滥用） | 占用服务器资源 | 默认 403（已实现），仅同机或已注册助手可部署 |

**关键判断**：在「只做推荐」的路径上，硬件档案是**用户自己的**数据，
伪造它只会让该用户拿到错误建议，跨不过任何信任边界。
所以这里**不需要**用加密来建立信任，需要的是：

1. **机密性** → HTTPS（若只有 HTTP，见第 9 节备选）
2. **绑定与重放控制** → 一次性 session token
3. **防篡改** → 对规范化 payload 做 HMAC
4. **可信度表达** → `trusted` / `confidence` 分级，而不是「加密 = 可信」

**反模式（明确避免）**：把加密密钥放进同一个下载文件。
能读到下载的人就能读到密钥，等价于没有加密。
真正的机密性只能来自传输层（HTTPS）或带外认证的密钥交换。

---

## 4. 推荐方案：检测会话（detection session）

### 4.1 时序

```
浏览器                          服务端                      用户本机
  |  POST /api/hardware/sessions   |
  |------------------------------>|
  |  {session_id, token, download, |
  |   report_url, expires_at}      |
  |<------------------------------|
  |  下载 mdp-probe-<sid>.ps1/.sh  |
  |---------------------------------------------------------->| 双击 / 一行命令
  |                               |   探测 nvidia-smi / sysctl /
  |                               |   注册表 / /proc/meminfo
  |                               |  POST /api/hardware/report
  |                               |  {token, payload, sig}
  |                               |<--------------------------|
  |                               |  验 token + 验签 + 消费 nonce
  |                               |  budget_from_profile + 交叉验证
  |                               |-------------------------->|
  |                               |  200 {profile_code, budget}
  |  轮询 GET /api/hardware/sessions/{sid}
  |------------------------------>|
  |  {state: reported, budget,    |
  |   profile_code, confidence}   |
  |<------------------------------|
  |  自动填档案 → 出推荐 → 同机启用部署 / 远端给命令
```

### 4.2 为什么用「会话 + 轮询」而不是直接粘贴

- 粘贴依赖用户正确复制一大段 base64，失败率高，且无法给中间反馈。
- 会话让网页能显示「正在等待本机探测…」，回传后**自动**完成后续流程。
- 回传失败时脚本仍打印档案码，页面保留粘贴框作为兜底。

### 4.3 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/hardware/sessions` | 建会话；返回 `session_id / token / download / expires_at` |
| GET | `/api/hardware/sessions/{sid}` | 轮询：`pending / reported / expired`，附 budget 与 profile_code |
| POST | `/api/hardware/report` | 探测脚本回传入口；校验 token、消费 nonce、返回档案码 |
| GET | `/api/hardware/probe/{token}.ps1` | Windows PowerShell 脚本（内嵌 token 与回调地址） |
| GET | `/api/hardware/probe/{token}.sh` | macOS / Linux shell 脚本 |
| GET | `/api/hardware/probe/{token}.py` | 有 Python 时的通用脚本（现有 `probe.py` 升级） |

`token = base64url(nonce) + "." + HMAC(server_secret, nonce)[:16]`。
服务端只需重算 `HMAC(server_secret, nonce)` 即可校验，不必存储密钥。
nonce 存于会话表，标记 `consumed_at`，默认 TTL 10 分钟。

### 4.4 会话状态机

```
created --(report 到达且验签通过)--> reported --(浏览器取走)--> consumed
   |                                    |
   +--(超过 TTL)--> expired <-----------+
```

内存字典即可（单进程），但建议落 SQLite：与现有 store 同库，
支持多 worker，也便于审计「有多少人真的跑了探测」。

### 4.5 签名

- 规范化：`json.dumps(payload, sort_keys=True, separators=(",", ":"))`
- 签名：`sig = HMAC(token, canonical_bytes)` 的 hex
- 校验：常量时间比较（`hmac.compare_digest`）
- 脚本端：Python 用 `hmac` + `hashlib`（标准库）；PowerShell 用 `HMACSHA256`；
  shell 用 `openssl dgst -sha256 -hmac`。

> 边界必须写清：签名能防**盲改**，防不住「既看到下载又看到回传」的主动中间人。
> 后者只能靠 HTTPS。不要给出虚假的安全承诺。

---

## 5. 跨平台探测：真正的价值在这里

浏览器读不到的，脚本能读到。这是「下载检测文件」的全部理由。

| 平台 | 显存 | 内存 | 陷阱 |
|---|---|---|---|
| Windows | 注册表 `HardwareInformation.qwMemorySize`（REG_QWORD） | `Win32_ComputerSystem.TotalPhysicalMemory` | **`Win32_VideoController.AdapterRAM` 是 uint32，大于 4GB 会截断或为 0，不能用** |
| Windows（有驱动） | `nvidia-smi --query-gpu=name,memory.total` | 同上 | nvidia-smi 不一定在 PATH |
| macOS | 统一内存 = 总内存（`sysctl -n hw.memsize`） | `sysctl -n hw.memsize` | `vm_stat` 算空闲页要注意 page size |
| macOS（型号） | `system_profiler SPDisplaysDataType -json` | — | 旧版可能无 JSON 输出 |
| Linux | `nvidia-smi` / `rocm-smi` | `/proc/meminfo` 的 `MemAvailable` | 容器里看不到宿主机 GPU |

Windows 那条 `AdapterRAM` 陷阱值得单独强调：它是很多「网页检测显存」方案
在 12GB 显卡上显示 4GB 的原因。读注册表 QWORD 才是对的。

探测脚本输出**原始事实**，不做判断（判断留在服务端，便于统一与测试）：

```json
{
  "probe_version": 2,
  "nonce": "...",
  "os": {"family": "windows", "version": "10.0.19045", "arch": "x86_64"},
  "cpu": {"model": "...", "physical_cores": 6, "logical_cores": 12},
  "ram": {"total_bytes": 34359738368, "available_bytes": 21474836480},
  "gpus": [{"vendor": "nvidia", "name": "NVIDIA GeForce RTX 3060",
            "vram_bytes": 12884901888, "vram_source": "registry"}],
  "uma": false,
  "backends": {"ollama": {"installed": true, "version": "0.3.1"},
               "llama_cpp": null, "vllm": null, "cuda": "12.4"},
  "notes": []
}
```

**默认不采集**：主机名、用户名、序列号、模型目录清单、磁盘路径。
需要时用 `--detailed` 显式开启，并在 UI 上说明。

---

## 6. 交叉验证：让「实测」和「查表」互相印证

服务端拿到探测结果后：

1. 用 `gpu_table.lookup(name)` 得到查表显存；
2. 与 `vram_bytes` 比较。

| 情况 | 判定 | confidence |
|---|---|---|
| 实测与查表一致（±0.5GB） | 互相印证 | `verified` |
| 实测有值、查表无条目 | 以实测为准 | `measured` |
| 两者不一致 | 取实测但提示「与型号标称不符，请确认」 | `disputed` |
| 只有浏览器查表值 | 未确认 | `unverified` |
| 用户手动确认 | — | `confirmed` |

这个表直接落到 `budget_from_profile` 的 `warnings` 与新增 `confidence` 字段，
并可 pin 成单元测试（沿用 `test_client_hardware.py` 的风格）。

---

## 7. 部署：为什么必须分成两个产物

| 产物 | 形态 | 能做什么 |
|---|---|---|
| 探测脚本 | 一次性，只读，跑完退出 | 精确推荐 |
| 本地助手 | 常驻，绑 `127.0.0.1:PORT` | 精确推荐 **+ 真实创建 / 启动 / 健康检查 / 测试** |

一次性脚本回传后进程就结束了，服务端**没有任何通道**再回到用户机器上启动模型。
所以「回传后部署」在远端场景下只能变成「回传后给你一条本机可执行的命令」。

要真正实现「网页上点部署、模型跑在我机器上」，只有本地助手：

```
用户本机: mdp-agent --service http://<service>      (绑 127.0.0.1:7411)
网页  →  fetch http://127.0.0.1:7411/hardware        (实时档案)
网页  →  fetch http://127.0.0.1:7411/deployments     (真实部署)
助手  →  需要时把匿名档位上报给服务（可选、可关）
```

约束（前置文档已列）：CORS、Chrome Private Network Access 预检需要
`Access-Control-Allow-Private-Network: true`、HTTPS 页面访问 `http://127.0.0.1`
属可信来源但仍需实测。**这是 P2 的活，先不做。**

---

## 8. 隐私优先的替代方案（更推荐的长期方向）

resolver 是纯函数，catalog 是静态数据。于是可以：

- 服务端提供 `GET /api/catalog`（entries + 常数）；
- 浏览器内置同一份 resolver（JS 移植），**本地算推荐**；
- 硬件只在本机流转：浏览器探测 → 可选本地脚本修正 → 本地计算。

这样**硬件根本不出本机**，第 3 节的加密问题从源头消失。
服务端退化为「目录 + 命令生成器 + 可选匿名统计」。

代价：Python 与 JS 两份实现需要保持同步。缓解办法是把**决策表 pin 成共享 fixture**
（同一组 budget × backend → 期望 model id / reason_key），两边跑同一份 golden，CI 比对。
现有 `backend/tests/test_recommendation.py` 已经是这种形态，扩展即可。

**如果服务运营方不需要遥测**，这条路比「加密回传」更简单也更安全。

---

## 9. 如果坚持要在 HTTP 上做应用层加密

只有在**服务确实只能跑 HTTP**且**档案含敏感字段**时才需要。可选：

1. **sealed box（推荐形态）**：服务端为每个会话生成临时 X25519 密钥对，
   公钥随下载下发；脚本用 `libsodium` / `cryptography` 封箱，服务端用私钥解封。
   缺点：客户端需要非标准库依赖。
2. **纯标准库 X25519 + ChaCha20-Poly1305**：约 250 行手写密码学。
   不推荐，除非有专人审计。
3. **静态二进制探测程序**：加密与探测一起编译，最好但分发成本最高
   （多平台构建、Windows SmartScreen）。

**默认建议**：与其做应用层加密，不如给服务加一层 HTTPS
（Caddy / nginx + 内网 CA）。一次配置，永久解决，且同时保护控制面。

---

## 10. 要改的代码（预估）

| 文件 | 改动 |
|---|---|
| `backend/app/services/probe_sessions.py` | 新增：会话、nonce、token、验签、TTL |
| `backend/app/services/probes.py` | 新增：按平台生成探测脚本（ps1 / sh / py） |
| `backend/app/services/profiles.py` | 档案码增加服务端签名（`mdp2`）；保留 `mdp1` 兼容 |
| `backend/app/services/hardware.py` | `budget_from_profile` 增加 `confidence` 与交叉验证警告 |
| `backend/app/main.py` | 新增 sessions / report / probe 路由；复用 `_base_url` |
| `backend/app/services/store.py` | 会话表（或先内存字典） |
| `frontend/index.html` | 检测会话 UI（等待 / 轮询 / 自动填充）；修第 1 节标签 |
| `backend/tests/test_probe_sessions.py` | 新增：token 校验、重放拒绝、TTL、交叉验证 |
| `docs/client-hardware-detection.md` | 阶段 C 升级为「会话式回传」，阶段 D 保持 |

---

## 11. 分阶段落地

| 阶段 | 内容 | 价值 | 风险 |
|---|---|---|---|
| P0 | 修「独立显存 · unknown」标签；显存来源可点改 | 消除最大误导 | 无 |
| P1 | 检测会话 + Windows/macOS/Linux 脚本 + 自动回传 + 轮询 UI | 一次点击拿到真实硬件 | 中 |
| P2 | 本地助手（loopback）：检测 + 真实部署 | 远端也能部署 | 高（PNA/CORS） |
| P3 | 档案码签名（分享/团队）、会话缓存、匿名统计开关 | 协作与运营 | 低 |

建议先做 P0 + P1，P2 单独立项。

---

## 12. 开放问题（需要你定）

1. 共享服务是否上 HTTPS？（决定要不要第 9 节）
2. 探测脚本是否允许上报「已安装的 ollama 模型」？（对推荐有帮助，但涉及隐私）
3. Windows 用户没有 Python 是否常见？（决定 PowerShell 脚本的优先级）
4. 是否需要匿名统计「多少人跑了探测 / 什么显卡」？（决定是否落库）
5. 本地助手（P2）是否值得做？还是「给命令让用户自己跑」就够？

---

## 13. 评估：做成桌面 App 是不是更好

**结论：是更好，但它解决的是另一个问题。**

你真正需要的是**两个产物**，之前把它们混在一起了：

| 产物 | 回答的问题 | 形态 |
|---|---|---|
| 一次性探测 | 「我这台机器该部署什么」 | 脚本即可 |
| 常驻 agent | 「帮我部署并持续管理」 | **只有 App 能做** |

脚本只能解决第一个。而你现在真正卡住的是第二个——远端用户拿不到部署能力。
所以 App 不是「更好的检测方式」，而是**缺失的另一半产品**。

### 13.1 App 带来的真实升级（远不止检测）

| 能力 | 脚本 | App | 说明 |
|---|---|---|---|
| 零运行时依赖 | 否（要 python3） | 是 | 直接解决 Windows 无 Python |
| 真实显存 | 是 | 是 | 读注册表 QWORD / nvidia-smi |
| **空闲显存** | 一次性快照 | 实时 | 决定 live 拟合 |
| **实测 tok/s** | 只能预测 | 可实测 | 见 13.2，价值最高 |
| 部署 / 启动 / 健康检查 / 测试 | 否 | 是 | 一次性进程做不到 |
| 持久化 + 自动更新 | 否 | 是 | 目录可热更新 |

### 13.2 最被低估的升级：把「预测」变成「实测」

现在 resolver 用带宽常数预测速度：

```
tok/s ~= bandwidth / (build_bytes * decode_fraction)
```

`bandwidth` 只有三档常数（1000 / UMA 210 / spill 80），本质是估计。
而速度恰恰是当前推荐链路里**最不可靠**的一环。

App 可以：跑一个固定的小模型 -> 实测 tok/s -> 反推这台机器的**有效带宽**
-> 存成本机校准系数，喂回 resolver。推荐依据从「查表估计」变成「本机实测」。

**这比「能部署」更有价值。**

### 13.3 代价：代码签名是硬门槛

| 平台 | 不签名的后果 |
|---|---|
| macOS | Gatekeeper 直接拦截，用户打不开；需要 Apple Developer（$99/年）+ 公证 |
| Windows | SmartScreen 警告；企业终端防护可能直接隔离 |
| Linux | 相对宽松，但分发方式要选（AppImage / 包管理器） |

其他成本：构建矩阵（Win x64/arm64、macOS Intel/Apple Silicon、Linux）、
自动更新通道、体积（Electron 150MB+ / Tauri 3-10MB / Go 5-20MB）。

**安全前提**：不要让用户从**还是 HTTP 的共享服务**下载并安装二进制。
必须 HTTPS + 签名 + 校验和。否则 App 的自动更新就是一条 RCE 通道。

### 13.4 关键架构结论：App 做了，resolver 就该搬进 App

- App 本地探测 + 本地 resolver + 本地部署
- 服务端退化为 `GET /api/catalog` + 可选匿名遥测
- **硬件不出本机** -> 第 3 节的加密问题彻底消失
- 第 12 节开放问题 1（远端能否在服务器部署）自动消解：
  远端部署发生在**用户自己的机器**上，服务端 403 规则不变，也不需要放开

这正是第 8 节「隐私优先」路径，App 让它成为默认形态。

### 13.5 推荐形态：Agent 自带本地 UI

```
+-- 用户机器 ------------------------------------------+
|  mdp-agent (Tauri / Go)                              |
|   |- 本地 UI   (内嵌现有 index.html)                  |
|   |- 本地探测  (sysctl / nvidia-smi / 注册表)          |
|   |- 本地 resolver (纯函数)                           |
|   +- 本地部署  (ollama / llama.cpp)                   |
+----------------------+-------------------------------+
                       | GET /api/catalog   (CORS *)
                +------v------+
                | 共享服务     |  目录 + 元数据 + 可选遥测
                +-------------+
```

**为什么 UI 要内嵌在 agent 里**：同源，绕开 Chrome Private Network Access 预检
与混合内容的所有麻烦（上一版 T3b 的主要风险）。
网页版仍然保留，作为「不想装」的降级路径。

选型倾向 **Tauri**：体积小，且能**直接复用现有 `frontend/index.html`**，
只需把 resolver 移植到 TS（配共享 golden fixture，见第 8 节）。

### 13.6 那 P1 的脚本还做不做

做。理由：

1. 它是 App 的**引导器**（下载页同时给「先试试脚本」和「下载 App」）
2. 它是**无安装降级路径**（公司电脑不允许装软件时）
3. 它更便宜，几天就能上，可先验证 payload schema 与交叉验证逻辑
4. 签名证书到位之前，它是唯一可行的精确路径

**决策点**：拿不到签名证书 -> 先做 P1；能拿到 -> P1 之后直接进 P2。

### 13.7 修订后的阶段

| 阶段 | 内容 | 前置 |
|---|---|---|
| P0 | 修「独立显存 · unknown」标签 | 无 |
| P1 | 检测会话 + 三平台脚本 | 无 |
| P2a | App 骨架：本地探测 + 本地 UI（复用 HTML） | **签名证书** |
| P2b | App 部署：ollama / llama.cpp 接管 | P2a |
| P2c | 实测带宽校准，喂回 resolver | P2b |
| P3 | 签名档案码、遥测开关、团队预设 | P1 |

---

## 14. Electron 落地设计

### 14.1 先纠正一个预期：Electron 不解决签名

Electron 省掉的是 **Rust 工具链**和**前端复用成本**，不是签名。

| 平台 | 不签名的后果 | 内部/局域网分发时 |
|---|---|---|
| macOS | Gatekeeper 拦截，需 Apple Developer + 公证 | 可 ad-hoc 签名 + 用户批准一次，或用 MDM 下发 |
| Windows | SmartScreen 警告，需点「仍要运行」 | 可接受；企业终端防护可能拦截，需加白名单 |
| Linux | 无强制签名 | AppImage / 内部源 |

**关键区别**：公开下载 vs 内部/局域网分发，难度差一个量级。
这个项目是内网工具，走内部渠道即可，不必一上来就买证书。

体积也不是问题：Electron 安装后约 150-250MB，下载包约 80-120MB。
但目标用户本来就要下 5GB 的模型权重——**200MB 是噪声**。
这一点反而让 Electron 在这里很合理。

### 14.2 为什么 Electron 在这个项目里确实合适

- 现有前端是**零构建的单文件 HTML**（`frontend/index.html`），可直接复用
- 主进程是 Node：`child_process` 跑 `sysctl` / `nvidia-smi` / `ollama` 很自然
- 不需要 Rust 工具链（Tauri 的主要成本）
- `electron-builder` 一套配置覆盖三平台打包
- 团队是 JS 背景

### 14.3 关键设计：主进程内置**同源** HTTP 控制面

```
Electron 主进程 (Node)
  |- BrowserWindow -> http://127.0.0.1:<port>/     <-- 加载现有 index.html
  |- 本地 HTTP 服务 (同源)
  |    GET  /api/hardware/self        本地探测
  |    POST /api/hardware/resolve     本地归一化
  |    GET  /api/hardware/gpus        本地查表
  |    POST /api/deployments          本地部署
  |    GET  /api/deployments/{id}/health
  |    POST /api/deployments/{id}/test
  |    *    /api/models/recommend     代理到共享服务（E1）或本地 resolver（E2）
  +- child_process: sysctl / nvidia-smi / ollama / llama-server
```

**为什么这样最省事**：窗口加载的是 `http://127.0.0.1:<port>/`，与本地 API **同源**。
于是 CORS、Chrome Private Network Access 预检、混合内容——上一版 T3b 的全部风险，
一次性消失。而且现有 `frontend/index.html` 里的 `fetch('/api/...')` **零改动**。

### 14.4 三个实现档次（这是真正的决策点）

| 档次 | resolver 在哪 | 硬件是否出本机 | 代码量 | 打包重量 |
|---|---|---|---|---|
| **E1 薄壳** | 共享服务（本地代理） | 是（仅容量数字） | 最小 | 最轻 |
| **E2 本地** | TS 移植进主进程 | 否 | 中 | 轻 |
| **E3 边车** | 打包现有 Python | 否 | 最小（复用全部） | 最重（PyInstaller） |

**E1 薄壳（建议起步）**：主进程只实现探测 + 部署 + 代理，推荐仍由服务端算。
前端零改动、Python 零改动、几周可出可用版本。
代价：硬件（仅容量数字）会发给共享服务，且离线不可用。

**E2 本地**：把 `catalog.py` / `estimator.py` 的 resolver 移植成 TS。
硬件不出本机、可离线。代价是 Python/TS 双实现，
必须用**共享 golden fixture** 锁住一致性（见第 8 节，`test_recommendation.py` 已是这个形态）。

**E3 边车**：PyInstaller 打包现有 FastAPI，主进程 spawn 它。
复用全部代码与 29 个测试，前端也零改动。
代价：包体再加 60-100MB，PyInstaller 对 uvicorn/fastapi 的打包比较挑，
且 macOS 要求 **.app 内所有二进制都签名**（主程序 + 边车），签名复杂度上升。

**推荐路径：E1 -> E2。** 先用薄壳最快拿到「能部署」这个核心价值，
等隐私或离线成为真实需求，再把 resolver 搬进主进程。E3 一般不值得。

### 14.5 目录结构（建议）

```
model-deploy-platform/
  frontend/index.html          <- 复用，不改
  backend/                     <- 保留，继续服务纯网页版
  desktop/                     <- 新增
    package.json
    electron-builder.yml
    src/main/index.ts          窗口 + 本地 HTTP + IPC
    src/main/http.ts           同源控制面（/api/* 子集）
    src/main/probe/darwin.ts   sysctl / system_profiler
    src/main/probe/win32.ts    注册表 QWORD / WMI
    src/main/probe/linux.ts    nvidia-smi / /proc/meminfo
    src/main/deploy/ollama.ts
    src/main/deploy/llamacpp.ts
    src/main/resolver/         E2 才需要
    src/renderer/              指向 ../../frontend/index.html
    golden/decision-table.json E2 的双实现一致性夹具
```

### 14.6 安全基线（Electron 特有，必须做）

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- preload 只暴露白名单 IPC，不暴露 `require` / `fs` / `child_process`
- 设置 CSP，禁用 `remote` 模块，校验所有 IPC 入参
- **部署命令不要拼接 shell 字符串**：用 `execFile(cmd, [args])` 传数组，避免注入
- 模型名 / 路径来自服务端目录时按不可信输入处理
- 自动更新通道必须 **HTTPS + 签名 + 校验和**，否则它就是一条 RCE 通道

### 14.7 与共享服务的关系

- 共享服务**保留纯网页版**，作为「不想装」的降级路径（现有实现不动）
- 服务端 403 规则不变：远端不能在服务器上部署；部署发生在用户本机，由 App 执行
- 服务端新增 `GET /api/catalog` 供 App 拉取并缓存（E1 用它，E2 离线也用它）
- 建议给 App 一个 `MDP_SERVICE` 配置项，指向内网服务地址

### 14.8 阶段修订（Electron 版）

| 阶段 | 内容 | 前置 |
|---|---|---|
| P0 | 修「独立显存 · unknown」标签 | 无 |
| P1 | 检测会话 + 三平台脚本（保留，作引导器与降级路径） | 无 |
| E1 | Electron 薄壳：本地探测 + 本地部署 + 代理推荐 | P0 |
| E2 | resolver 移植进主进程 + golden 一致性夹具 | E1 |
| E3 | 实测带宽校准，喂回 resolver | E2 |
| P3 | 签名档案码、遥测开关、团队预设 | P1 |

**分发**：内部渠道 + 代码签名（可后置）。打包用 `electron-builder`，
macOS 出 `.dmg`、Windows 出 `nsis`、Linux 出 `AppImage`。

### 14.9 已落地的最小骨架（`desktop/`）

第 14.1 节把**分发**的复杂度当成了**开发**的复杂度，这是错的。
内网自用就是 `npm i && npm start`，**签名只在对外公开分发时才是问题**，
可以无限期后置；打包同理。

已创建 5 个文件：

| 文件 | 作用 |
|---|---|
| `desktop/package.json` | 唯一依赖 `electron`；`npm start` |
| `desktop/main.js` | 建窗口，加载本地同源地址 |
| `desktop/server.js` | 同源控制面：探测 + 注入档案转发 + 其余代理 |
| `desktop/probe.js` | 三平台探测（sysctl / vm_stat / nvidia-smi / 注册表 QWORD / proc） |
| `desktop/README.md` | 使用说明 |

已验证：

- `node --check` 三个文件全部通过
- `probe()` 在本机返回真实数据：Apple M5 / 24GB / 10 核 /
  空闲 7.6GB / ollama 9 个模型

跑起来：

```bash
cd desktop
npm install
npm start
```

指向局域网控制面：

```bash
MDP_SERVICE=http://100.100.182.242:8790 npm start
```

**尚未实现**：本地部署。`/api/deployments` 目前仍转发给控制面，
所以部署仍发生在控制面所在机器。要真正部署到本机，需在主进程 spawn
`ollama` / `llama-server`（约 100 行），这是 E1 的剩余部分。


