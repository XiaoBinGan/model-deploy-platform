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
| vLLM / SGLang | 明确 `BLOCKED`（面向 Linux 服务器） |

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
