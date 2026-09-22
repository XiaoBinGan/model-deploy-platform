# 客户端硬件检测设计（共享服务场景）

> 状态：阶段 A / B / C 已实现（分支 `feat/client-hardware-profile`）；阶段 D（本地助手）与 E（分享/团队）待做。
> 目标：让「多人共用一个服务，检索自己本地该部署什么模型」在语义上成立。

---

## 1. 问题

当前 `/api/environment/latest` 与 `/api/models/recommend` 都在**服务端**调用 `probe_budget()`。

- 本机访问（浏览器与服务同机）→ 结果正确
- 局域网 / 共享服务访问 → 返回的是**服务器**的 GPU 与内存，不是用户自己的机器

目标场景是「很多人用同一个服务，检索自己本地该部署什么模型」。
在这个场景下，服务端探测在语义上就是错的：需要的是**用户机器的硬件画像**，不是服务器的。

---

## 2. 核心决策

**硬件档案随请求走（profile travels with the request）。**

resolver 保持纯函数：`resolve(budget, backend, entries)`。变化只在于 `budget` 从哪来：

- 过去：`probe_budget()`（服务端探测）
- 现在：`budget_from_profile(profile)`（客户端提交，服务端校验并钳制）

服务端不再假设「我探测到的就是用户的机器」，而是把硬件当作**请求参数**。
这也让推荐路径天然无状态，横向扩展只是一次纯函数调用。

---

## 3. 为什么不能只靠浏览器

浏览器出于安全考虑，不暴露显存与总内存。能力矩阵：

| 信号 | API | Chrome/Edge | Firefox | Safari | 说明 |
|---|---|---|---|---|---|
| CPU 核数 | `navigator.hardwareConcurrency` | 支持 | 支持 | 支持 | 可靠 |
| 内存 | `navigator.deviceMemory` | 部分 | 不支持 | 不支持 | 只有粗档位，且**封顶 8GB** |
| GPU 名称 | WebGL `UNMASKED_RENDERER_WEBGL` | 支持 | 支持 | 部分 | Safari 常返回 Apple GPU |
| GPU 信息 | WebGPU `GPUAdapter.info` | 支持 | 不支持 | 部分 | 有 vendor/architecture，**无显存** |
| 平台/架构 | `userAgentData.getHighEntropyValues` | 支持 | 不支持 | 不支持 | 需要安全上下文 |
| 磁盘 | `navigator.storage.estimate()` | 支持 | 支持 | 支持 | 是配额，非真实剩余 |

结论：**显存读不到，总内存只有粗档位，Apple Silicon 在 Safari 下连 GPU 型号都可能被遮蔽。**
所以浏览器探测只能作为「预填 + 用户确认」，不能作为唯一依据。

三个关键推论：

1. 显存不可查询，所以 **GPU 型号 → 显存查表** 是必要的。
2. Apple Silicon 的统一内存等于总内存，而 `deviceMemory` 封顶 8GB 且 Safari 不支持，
   因此**必须让用户选内存档位**。
3. 精确检测只有一条路：**在用户本机跑一次探测**。

---

## 4. 四层策略

| 层级 | 来源 | 精度 | 用户成本 | 用途 |
|---|---|---|---|---|
| T0 | 服务端 + 客户端位置判定 | 低（只判断是否同机） | 0 | 修复「共享服务显示服务器硬件」 |
| T1 | 浏览器探测 | 中（GPU 型号 + 档位内存） | 0 | 预填表单 |
| T2 | 用户手动确认 / 修正 | 高（用户知道自己的机器） | 低 | 兜底 + 修正 |
| T3 | 本地探测（一行命令 / 本地助手） | 最高（真实 nvidia-smi / sysctl） | 中 | 精确规划 |

### T0 客户端位置判定（最小改动，立刻修复当前问题）

服务端比较请求来源 IP 与本机网卡地址：

- loopback（127.0.0.1 / ::1）→ 同机 → 服务端探测有效
- 其他 → 远端 → 服务端探测**不代表用户机器**

响应增加 `client_is_local` 与 `hardware.source`，UI 明确标注：

> 你正在使用共享服务，当前显示的是**服务器**硬件。 [检测我的机器]

### T1 浏览器探测

采集：CPU 核数、内存档位、WebGL GPU 名称、WebGPU 适配器信息、平台/架构、磁盘配额。
把 GPU 名称归一化后交给服务端查表（`/api/hardware/gpus`），得到显存与 UMA 判定。例如：

- `Apple M4 Pro` → UMA，显存 = 总内存（需用户确认档位）
- `NVIDIA GeForce RTX 4090` → 24GB 独立显存
- `AMD Radeon RX 7900 XTX` → 24GB
- `Intel Iris Xe` → 共享内存

### T2 手动确认

检测值全部**可编辑**；提供常见机型预设（M1 8/16、M2 Pro 16/32、M3 Max 36/48、
RTX 3060 12G、4090 24G 等）。当 `deviceMemory` 缺失或封顶时，显式要求用户选择。

### T3 本地探测

两个子方案：

**T3a 一行命令 + 粘贴档案码（推荐：零安装、无网络暴露）**

```
curl -fsSL <service>/probe.sh | sh
```

输出一段 base64url 的「档案码」，用户粘回网页；服务端解码并校验版本与校验和。

**T3b 本地助手（体验最好，约束最多）**

用户在本地跑 `mdp-probe`，它监听 `127.0.0.1:PORT` 返回档案，网页直接 fetch。
约束：需要 CORS，且 Chrome 的 Private Network Access 预检可能触发
（私网页面 → localhost 属于「更私密」方向，会带 `Access-Control-Request-Private-Network`）。
HTTPS 页面访问 `http://127.0.0.1` 通常被当作可信来源，可行但需实测。

---

## 5. 数据模型

客户端提交（**不可信输入**）：

```json
{
  "source": "browser",
  "confidence": "medium",
  "platform": "darwin",
  "architecture": "arm64",
  "cpu_cores": 10,
  "ram_gb": 24,
  "gpus": [{"name": "Apple M4 Pro", "vendor": "apple", "vram_gb": null, "uma": true}],
  "backends": {"ollama": "0.5.7", "llama_cpp": null, "vllm": null, "cuda": null},
  "disk_free_gb": 512
}
```

服务端归一化（校验/钳制后）：

```json
{
  "usable_vram_bytes": 20615843020,
  "total_device_bytes": 25769803776,
  "ram_available_bytes": 0,
  "uma": true,
  "source": "client:browser",
  "trusted": false,
  "warnings": ["VRAM 由 GPU 型号查表得到", "内存档位为浏览器估算，请确认"]
}
```

钳制规则：`vram_gb` 与 `ram_gb` 取 [0.5, 4096]，`cpu_cores` 取 [1, 1024]，
拒绝 NaN / 负数 / 超长字符串，限制 GPU 数量；客户端提交一律 `trusted=false`。

注意：远端客户端的**空闲内存不可知**。目录定价用的是 `planning=True`（总容量减 margin），
所以不受影响；真正的 live 拟合必须在客户端本机做。

---

## 6. 共享服务下的两种模式

这是共享服务最关键的产品结论：**服务端不能替远端用户部署模型**——那会部署到服务器上。

| 模式 | 适用 | 输出 |
|---|---|---|
| 检索（advisory） | 远端用户 | 推荐 + `reason_key` + **本机可执行的一键命令** |
| 部署（control plane） | 同机用户，或已注册本地助手的用户 | 真实创建 / 启动 / 健康检查 / 测试 |

因此「参数预览」产出的命令在共享场景下从「预览」升级为**交付物**：
用户复制到本机执行即可，例如 `ollama pull qwen3:8b` 或 `llama-server -m ... -c 65536 -ctk q8_0 -fa on`。

---

## 7. API 设计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/hardware/self` | 服务器自身档案（显式标注 source=server） |
| POST | `/api/hardware/resolve` | 归一化客户端档案 → budget + warnings |
| GET | `/api/hardware/gpus` | GPU 型号 → 显存 / UMA 查表（单一数据源） |
| GET | `/api/hardware/probe-command` | 按 UA 返回对应平台的一行探测命令 |
| POST | `/api/hardware/profile-code` | 档案码编码 / 解码（版本 + 校验和） |

`POST /api/models/recommend` 增加可选 `hardware` 字段；
响应回显 `client_is_local`、`hardware.source`、`trusted`、`warnings`。

---

## 8. UI 设计

顶部横幅：

- 同机：`已检测本机`
- 远端：`共享服务 · 当前为服务器硬件 [检测我的机器]`

硬件档案面板：检测值可编辑 + 来源徽标（浏览器 / 手动 / 本地助手）+ 置信度 + 警告。

流程：`自动检测 → 确认修正 → 推荐 →（同机）部署 /（远端）复制命令`。

---

## 9. 安全与隐私

- 客户端档案是不可信输入：只校验、只钳制，绝不执行
- 默认不持久化用户硬件；如需统计则匿名化并允许退出
- 共享服务需对 `/api/models/recommend` 限流
- 本地助手只绑 loopback，且必须 opt-in
- 不向远端泄露服务器 `nvidia-smi` 细节（除非有意）
- 控制面本身无鉴权，公网暴露必须加反向代理鉴权

---

## 10. 分阶段落地

| 阶段 | 内容 | 价值 |
|---|---|---|
| A | 客户端位置判定 + 来源标注 + 手动输入 | 立刻修复当前 bug |
| B | 浏览器探测 + GPU 查表 | 零成本预填 |
| C | 一行命令 + 档案码 | 精确且无安装 |
| D | 本地助手（localhost HTTP）+ WebGPU 交叉验证 | 最佳体验 |
| E | 会话级档案缓存 / 分享链接 / 团队预设 | 协作 |

---

## 11. 测试策略

- 单元：`budget_from_profile` 钳制、GPU 名称解析与查表、UMA / 独立显存判定
- 契约：同一 budget 下 resolver 决策表不变（现有 `test_recommendation.py` 直接复用）
- E2E：模拟非回环来源 → `client_is_local=false` 且 `hardware.source=server` + 警告
- Golden：GPU → 显存表条目 pin 住

---

## 12. 开放问题

1. 远端用户是否允许在服务器上触发部署？（建议默认禁止或管理员门控）
2. `deviceMemory` 封顶 8GB，是否当作下界并在 UI 强制确认？
3. 是否要账号 / 团队，还是完全匿名？
4. 共享服务是否 HTTPS？这会影响本地助手与 PNA 预检。
5. GPU → 显存表放服务端（可热更新，推荐）还是打包进页面？
