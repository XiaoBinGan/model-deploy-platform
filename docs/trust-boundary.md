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

## DESK-17 · 页面完全没有 CSP（一般）

Electron 在开发模式下会打印 `Insecure Content-Security-Policy` 警告。
这条警告只在未打包时出现，但「没有 CSP」这个事实一直都在：
渲染进程是唯一直接渲染控制面数据的地方，而控制面按设计是不可信的，
页面却可以自由地去外部取脚本 / 帧 / object。

**第一次修法**：在 `frontend/index.html` 里加 `Content-Security-Policy` meta，
但 `script-src` 只能写 `'unsafe-inline'`。

**第二步（最终形态）**：把 `'unsafe-inline'` 也去掉。

```
default-src 'none'; script-src 'nonce-<每次响应随机>'; style-src 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'
```

`frontend/index.html` 里写的是**占位符** `{{CSP_NONCE}}`，不是值。
两个会送出这个文件的服务端各自在响应时替换成随机值：

- `desktop/server.js` 的 `renderIndex()`
- `backend/app/main.py` 的 `_render_index()`（原先的 `StaticFiles` 挂载必须撤掉，
  否则它会原样送出带占位符的文件）

**为什么必须是随机的**：这个仓库是公开的。如果 nonce 是一个写死的字符串，
那它就是一个**公开常量** —— 能注入 markup 的人可以直接把它抄进
`<script nonce="...">`，CSP 就纯粹是装饰。固定 nonce 在「防注入」这个场景下
提供的保护等于零，而这恰恰是它唯一存在的理由。

**占位符缺失时两个服务端都会大声失败**（500 + 明确原因），而不是静默返回
一个 CSP 形同虚设的页面。宁可页面挂了，也不要一个看起来在保护、实际没保护的页面。

### 怎么去掉 `script-src 'unsafe-inline'` 的

它之所以去不掉，是因为页面有 **24 处内联事件处理器**（`onclick=` / `onchange=`）。
全部改成 `data-act` / `data-change` 属性 + 一个挂在 `document` 上的委托监听之后，
`script-src` 就只剩页面自己那一个极具 `nonce` 的 `<script>` 块。

副作用是好的：`script-src-attr` 会回退到 `script-src`，所以**注入的内联事件处理器
（例如 `<img onerror=...>`）也会被拒**，不只是 `<script>` 标签。

### 这条 CSP 的真实边界（实测，不是推断）

在真实渲染进程里注入脚本，看浏览器到底拦不拦：

| 注入内容 | 结果 | 触发 |
|---|---|---|
| 外部 `<script src="https://example.com/evil.js">` | **被拦** | `script-src-elem` 违规事件 |
| 内联 `<script>window.__INL = true</script>` | **被拦** | `script-src` 违规事件 |

（改成 nonce 之前，第二行的结果是「执行了」。`test-frontend.js` 里那条哨兵测试
原本断言 `inlineRan === true` 并注明「这是已知边界，不是回归」；去掉 `unsafe-inline`
之后它按设计变红，于是改成断言新的、更强的行为。）

### 一条我写错过的论断（留在这里以免再犯）

上一版这条文档里写着「浏览器会对 `getAttribute('nonce')` 隐藏 nonce 值，
所以注入的标签读不到」。**这是错的**，实测：

| 读法 | 实测结果 |
|---|---|
| `script.getAttribute('nonce')` | **返回真实值**（没有被隐藏） |
| `script.nonce` | 返回真实值 |

（我原本以为这是 CSP3 的 nonce hiding，但在这个 Electron/Chromium 里没有生效。）
真正拦住注入的**不是**「读不到 nonce」，而是「**跑不了脚本**」——
而读 nonce 本身就需要跑脚本。所以随机 nonce 依然成立，只是理由换了：
保护来自「每次响应都不同、无法预先猜到」，不来自「读不到」。

这也说明为什么固定 nonce 不行：它不需要被「读」，它就在公开仓库里。

### 仍然要说清楚的限制

- **nonce 不是 XSS 防护的替代品**。如果 `esc()` 没漏，注入根本进不来；
  这条 CSP 是「万一漏了」的第二层。防注入的主防线仍然只有
  `esc()` / `badge()` / `textContent`。
- **两个服务端的替换逻辑是各自实现的**，没有共享代码。一处改了另一处没改
  不会被测试直接发现（两侧各有独立测试，但测的是各自的行为）。
- **`style-src 'unsafe-inline'` 保留**：页面有一个内联 `<style>` 块，
  以及遍布各处的 `style=""` 属性。样式注入的危害远小于脚本注入。
- **没有写 `frame-ancestors` 和 `sandbox`**：这两个指令通过 `<meta>` 传递时
  会被忽略，写上去只会让人以为有保护。测试里专门断言它们**不在** CSP 中。

其他实测：`fetch('https://example.com')` 被拒（`connect-src`），
同源 `/api/health` 正常，`eval` 被拒（脚本源没有 `unsafe-eval`）。

---

## 测试

```bash
cd backend && .venv/bin/python -m pytest tests/test_trust_boundary.py -q   # 19 passed
cd backend && .venv/bin/python -m pytest tests/test_frontend_nonce.py -q   # 5 passed
cd desktop && node test-trust.js                                          # 15 passed
cd desktop && node test-server.js                                         # 81 passed（含 5 条 nonce 断言）
```

前端侧另有 8 条 CSP / 注入断言在 `desktop/test-frontend.js`（真的在渲染进程里验证）。

backend 侧覆盖：默认没有 CORS 中间件、跨源预检拿不到放行头、5 个写操作对远端全部 403、
`MDP_ALLOW_REMOTE_DEPLOY=1` 仍能放开、读操作对远端保持开放、
外部 Host 头不被回显、回环 Host 头保留。

## 有意保持开放的

- **读接口对远端开放**：`/api/health`、`/api/models/catalog`、`/api/deployments`、
  `/api/backends`、`/api/plans/preview`。共享服务的用途就是给网络发推荐结果。
- **`MDP_ALLOW_REMOTE_DEPLOY=1` 可以把写操作放开**：单租户可信机器上的运维开关。
- **控制面仍然无鉴权**。这些改动收紧的是「未鉴权调用者能做什么」，
  不是「调用者是谁」。要暴露到不可信网络，仍需自行加一层反向代理和认证。
