# mdp-desktop

Electron 桌面端。窗口加载的页面与本地 API **同源**，
所以没有 CORS、没有 Private Network Access 预检、没有混合内容问题，
`frontend/index.html` 也**零改动**。

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

## 已知限制

- llama.cpp 需要本机 `.gguf` 文件路径；HuggingFace 仓库 id 不能直接启动
- 部署记录存在 app userData 目录；重启后旧进程状态标记为 STOPPED
- Windows 未签名首次运行会有 SmartScreen 提示
