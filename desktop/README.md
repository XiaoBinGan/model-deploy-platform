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

没有签名步骤，没有打包步骤。内网自己用不需要 electron-builder。

## 它做了什么

- `GET  /api/hardware/self` -> 本地实测（sysctl / nvidia-smi / 注册表 QWORD / proc）
- `POST /api/models/recommend` -> 注入本机档案后转发给控制面
- 其他 `/api/*` -> 原样转发给控制面
- 页面本身 -> `../frontend/index.html`

## 控制面地址

默认 `http://127.0.0.1:8790`，用环境变量改：

```bash
MDP_SERVICE=http://100.100.182.242:8790 npm start
```

## 还没做的

- 本地部署：`/api/deployments` 目前仍转发给控制面，
  所以部署仍发生在控制面所在机器。要真正部署到本机，
  需要在主进程里 spawn `ollama` / `llama-server`（约 100 行）。
- Windows 未签名首次运行会有 SmartScreen 提示，内网可忽略。
