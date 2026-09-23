# 信任边界：控制面是提示源，不是命令源

控制面无鉴权。所以「它会为未鉴权的调用者做什么」就是全部的安全故事。
这一轮把三处过于宽松的地方收紧了，另加桌面端两处。

原则只有一条：**服务端只提供数字和文本，不提供可执行的东西。**

---

## DESK-01 · 桌面端原样执行控制面给的 argv（严重，本机 RCE）

`/api/plans/preview` 会返回一个拼好的 `command`，桌面端直接 `spawn` 它：

```js
const r = await fetch(this.service + "/api/plans/preview", {...});
proc = spawn(r.command[0], r.command.slice(1));   // 修前
```

控制面无鉴权，且当 `service` 指向远端时，「控制面」未必真的是控制面。
谁能应答那个地址，谁就在这台 Mac 上有任意命令执行。

**修法**：argv 一律本地拼，服务端只贡献一个整数——上下文窗口。

```js
const window = safeWindow(data.decision.planned_window);  // 1024..1048576，否则丢弃
const argv = this._llamaArgv(item, window);               // 本地拼
```

顺带收紧的：

- `safeWindow()` 把窗口夹在 1024~1048576，非数字或越界一律当「没有意见」，
  回退到默认 65536。`"65536; touch /tmp/x"` 这种值到不了 argv。
- `safeWarnings()` 把警告里的换行压平。警告会被写进部署日志，
  带换行的警告可以伪造出额外的日志行。
- `create()` 的端口加了 1024~65535 校验（原来是 `Number(req.port) || 8000`，
  负数和 99999 都会被接受）。

**测试**：`desktop/test-trust.js`（11 项）。它起一个**敌对服务**，返回
`command: ["<evil.sh>"]`，然后断言 `evil.sh` 从未被执行、argv 里是本地拼的
`llama-server`、但服务给的窗口 32768 仍然生效。第二个用例把命令注入到
窗口值里，断言回退到 65536 且元字符没进 argv。

```bash
cd desktop && node test-trust.js
```

---

## B-01 · CORS 全开（严重）

`allow_origins=["*"]` 配上一个无鉴权的控制面，意味着**用户访问的任何网页**
都能从用户浏览器里驱动它，包括在局域网主机上创建和启动部署。

**修法**：默认不装 CORS 中间件。页面本来就同源——桌面端从本地控制面加载页面，
浏览器打开局域网地址也是同源——所以没有任何跨源需求。没有中间件之后，
跨源 JSON POST 连预检都过不了，请求根本不会发出。

真的需要分离部署时用 `MDP_CORS_ORIGINS=https://a.example,https://b.example` 显式开。

## B-04 · 本地校验只保护了创建（严重）

`POST /api/deployments` 检查了调用者是否本机，但 `start` / `stop` / `delete` / `test`
完全没查。远端调用者不能新建部署，却仍能启动、停止、删除已有部署，
并借用模型跑对话——对这台机器的控制权是一样的，只是换了条路。

**修法**：`_require_local()` 加到全部 5 个写操作上。**读操作保持开放**，
这样共享服务仍然可以把推荐结果发给网络。

```bash
# 远端：403
curl -X POST http://<lan-ip>:8790/api/deployments/dep_x/start
```

## B-12 · Host 头被回显进 URL（一般）

`_public_host()` 直接取 `Host` 头，而它会被拼进 `endpoint` / `health_endpoint`
返回给前端。前端拿这些 URL 去发请求，所以攻击者控制的 Host 头可以把它们指向别处。

**修法**：只有确实指向本机的名字（回环或本机网卡地址）才回显，否则用本机地址替换。
IPv4 优先，因为那是用户能直接粘贴的形式。

## DESK-16 · openExternal 接受任意协议（一般）

```js
win.webContents.setWindowOpenHandler(({ url }) => {
  shell.openExternal(url);    // 修前：file:// 也能交给系统
  return { action: "deny" };
});
```

**修法**：只放行 `http:` / `https:`，其余静默丢弃。另加 `will-navigate`，
阻止页面把窗口导航离开本地应用（这样点击链接是交给系统浏览器打开，
而不是把 UI 替换掉）。

---

## 测试

```bash
cd backend && .venv/bin/python -m pytest tests/test_trust_boundary.py -q   # 19 passed
cd desktop && node test-trust.js                                          # 11 passed
```

backend 侧覆盖：默认没有 CORS 中间件、跨源预检拿不到放行头、5 个写操作对远端全部 403、
`MDP_ALLOW_REMOTE_DEPLOY=1` 仍能放开、读操作对远端保持开放、
外部 Host 头不被回显、回环 Host 头保留。

## 有意保持开放的

- **读接口对远端开放**：`/api/health`、`/api/models/catalog`、`/api/deployments`、
  `/api/backends`、`/api/plans/preview`。共享服务的用途就是给网络发推荐结果。
- **`MDP_ALLOW_REMOTE_DEPLOY=1` 可以把写操作放开**：单租户可信机器上的运维开关。
- **控制面仍然无鉴权**。这些改动收紧的是「未鉴权调用者能做什么」，
  不是「调用者是谁」。要暴露到不可信网络，仍需自行加一层反向代理和认证。
