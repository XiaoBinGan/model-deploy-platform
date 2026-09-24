
# desktop/ QA 发现报告

- 仓库：/Users/supre/Documents/tmp/model-deploy-platform
- 分支：feat/client-hardware-profile（未切换、未合并、未 push、未改源码）
- 被测目录：desktop/（probe.js / deploy.js / server.js / main.js / smoke.js）
- 环境：Apple M5 / 24GB 统一内存 / macOS / Node v22.23.2；控制面 http://127.0.0.1:8790 在跑；Ollama 11434 在跑（9 个模型）
- 方法：node smoke.js（12/12）、node smoke.js --ollama qwen3:8b（16/16）、在 /tmp 下用桩替换 child_process.execFile、用假 llama-server / 假 ollama 走真实部署生命周期、真机 ollama 共享模型验证
- 临时脚本与产物：/tmp/mdptest/（不在仓库内）

结论：核心冒烟全绿，探测在本机数值正确，命令参数化（无 shell 注入）与路径穿越防护正确；但**部署生命周期存在多条进程泄漏路径、stop/start 存在竞态、控制面返回的命令被原样执行**。共记录 28 条：严重 6、一般 10、轻微 9、存疑 3。

---

## A. 确认的 bug（真机 / 真路径复现）

### DESK-01 控制面返回的 plan command 被原样执行，可导致本机任意命令执行（RCE）

- 严重程度：严重（若 MDP_SERVICE 指向非本机 HTTP 地址，可升级为阻断）
- 位置：desktop/deploy.js:297-328（_plan）、desktop/deploy.js:241-252（_runLlama spawn）、README.md:71-74（MDP_SERVICE 可指向远程）
- 复现：起一个假控制面，/api/plans/preview 返回任意命令数组，再让桌面端启动一个 llama.cpp 部署：

```js
// /tmp/mdptest/inject.js 片段
const stub = http.createServer((req,res)=>{
  req.on("data",()=>{}); req.on("end",()=>{
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({ command:["/bin/sh","-c","echo PLAN-RCE > /tmp/mdptest/pwned_plan"], warnings:["x"] }));
  });
});
stub.listen(0,"127.0.0.1",()=>{
  const { Deployments } = require(".../desktop/deploy.js");
  const d = new Deployments("/tmp/mdptest/data_inject", "http://127.0.0.1:"+stub.address().port);
  const it = d.create({ backend:"llama.cpp", model_path:"/tmp/mdptest/fake.gguf", port:18400, model_id:"x" });
  d.start(it.id);
});
```

- 期望：只允许执行受信任的 llama-server，或对 command[0] 做白名单/签名校验；至少不要把控制面返回的任意可执行文件与参数直接交给 spawn。
- 实际：
```
A) status: STOPPED
A) pwned_plan exists: true content="PLAN-RCE"
A) log: ["警告：from malicious service","llama-server 退出，code=0"]
```
- 影响：控制面被入侵、被中间人（默认 http:// 明文）、或 MDP_SERVICE 指向他人机器时，桌面端会在用户本机执行任意命令。这是桌面端最严重的信任边界问题。

### DESK-02 重复调用 start() 会泄漏一个无法回收的 llama-server

- 严重程度：严重
- 位置：desktop/deploy.js:134-146（start 只拦 RUNNING，未拦 STARTING）、deploy.js:252（procs.set 覆盖前一个）、deploy.js:266-274（close 无条件 procs.delete）
- 复现：
```js
const d = new Deployments("/tmp/mdptest/data_dup","");
const it = d.create({backend:"llama.cpp",model_path:"/tmp/mdptest/fake.gguf",port:18102,model_id:"x"});
d.start(it.id); d.start(it.id);   // 第二次在 STARTING 期间调用
```
- 期望：STARTING 期间再次 start 应幂等返回，或先停掉旧进程。
- 实际：spawn 出两个进程（75572、75573），第二个 EADDRINUSE 退出并把状态改成 FAILED，procs.set 已被覆盖，close 又把 procs 删空；第一个进程仍在监听，stop() 也杀不掉：
```
spawn pid=75572 port=18102 mode=ok
listening pid=75572 port=18102
spawn pid=75573 port=18102 mode=ok
listen-error EADDRINUSE pid=75573 port=18102
after 4s status FAILED | procs.size 0
after stop status STOPPED | procs.size 0
--- surviving fake procs ---
75572 node /tmp/mdptest/bin/llama-server -m /tmp/mdptest/fake.gguf ... --port 18102
```
通过 HTTP 触发同样复现（PID 78953 泄漏）。
- 影响：端口被占死、显存/内存不释放，用户在 UI 里看到 STOPPED/FAILED 但进程仍在跑；只能手动 kill。

### DESK-03 健康检查 90s 超时后不杀子进程，留下孤儿 llama-server

- 严重程度：严重
- 位置：desktop/deploy.js:276-285（_runLlama 超时分支只改状态）、deploy.js:287-295（_waitHealthy）
- 复现：用 FAKE_MODE=unhealthy（/health 恒 500）跑一次正常 start，等 91s：
```
settled after 91s
status: FAILED pid: 76969 procs.size: 1
last log: ["命令：llama-server ...","等待健康检查超时（90s）"]
pgrep inside node: 76969 node /tmp/mdptest/bin/llama-server ... --port 18105
EXITING WITHOUT stop()
--- after node exit ---
76969 node /tmp/mdptest/bin/llama-server ... --port 18105
```
- 期望：超时应 kill 进程并清空 procs。
- 实际：状态 FAILED，但进程存活；父进程退出后它被 launchd 收养继续运行。
- 影响：启动失败后残留进程长期占用内存/显存/端口，属于典型的孤儿进程泄漏。

### DESK-04 stop() 只发 SIGTERM，进程忽略信号时状态谎报 STOPPED

- 严重程度：严重
- 位置：desktop/deploy.js:330-359（proc.kill("SIGTERM")，无 SIGKILL 升级、不等待退出、先删 procs）
- 复现：FAKE_MODE=ignore-term（忽略 SIGTERM），start 到 RUNNING 后 stop：
```
status before stop: RUNNING pid: 80373
after stop: status STOPPED pid null procs.size 0
--- survivors ---
80373 node /tmp/mdptest/bin/llama-server ... --port 18600
--- log ---
SIGTERM pid=80373 mode=ignore-term
```
- 期望：SIGTERM 后等待一段时间，仍存活则 SIGKILL，并确认退出后才置 STOPPED。
- 实际：立即置 STOPPED 且从 procs 删除，进程继续运行且再无法通过 stop() 管理。
- 影响：状态与实际不符；端口/内存不释放。llama.cpp 在加载大模型时对 SIGTERM 的响应可能较慢，同样会命中。

### DESK-05 ollama pull 没有超时，且其子进程不受 procs 管理

- 严重程度：严重
- 位置：desktop/deploy.js:196-220（_ollamaPull，spawn 无 timeout，proc 不入 this.procs）、deploy.js:156-183（_runOllama 无超时；START_TIMEOUT_S 只用于 llama.cpp）
- 复现：假 ollama 执行 pull 时 sleep 60，模型名不在 /api/tags：
```
12s after start, status: STARTING | log: ["本地没有 definitely-not-installed-xyz，开始 ollama pull（可能要几分钟）…"]
after stop: status STOPPED (hung pull child is not in procs, cannot be killed)
--- fake ollama survivors ---
81598 /bin/bash /tmp/mdptest/bin/ollama pull definitely-not-installed-xyz
```
- 期望：pull 应有超时/可取消，并且子进程要登记以便 stop 时回收。
- 实际：状态可无限期停在 STARTING；stop() 后 pull 进程仍在跑。
- 影响：卡死的 pull 占住部署并持续占网络/磁盘；stop 无法真正停止。

### DESK-06 ollama 启动过程中 stop() 被覆盖，状态回到 RUNNING 且模型重新驻留

- 严重程度：严重
- 位置：desktop/deploy.js:156-183（_runOllama 在 await /api/generate 之后无条件写 RUNNING/FAILED，不检查是否已被 stop）
- 复现：真机 qwen3:8b，start 后 0.7s 调 stop，再等 25s：
```
before stop: STARTING
immediately after stop: STOPPED
25s after stop: RUNNING | log: ["加载 qwen3:8b 到内存…","qwen3:8b 已从 Ollama 卸载","qwen3:8b 已常驻内存（keep_alive 30m）"]
ollama ps: ["qwen3:8b"]
```
- 期望：stop 之后 _runOllama 的后续写状态应被丢弃（检查代次/状态）。
- 实际：stop 已把模型卸载，但 in-flight 的 generate 完成后又把状态改回 RUNNING，并让模型重新常驻内存。
- 影响：用户点了停止，界面却显示运行中、模型被重新加载，内存再次被占。

---

### DESK-07 停止一个 ollama 部署会卸载另一个部署共享的模型，而后者仍报 RUNNING/healthy

- 严重程度：一般
- 位置：desktop/deploy.js:342-354（stop 对所有 ollama 部署都发 keep_alive:"0"）、deploy.js:361-371（health 只看 /api/tags 的 200）
- 复现：两个部署都用 qwen3:8b，都 start 到 RUNNING，然后 stop 第二个：
```
A status: RUNNING | ps: [ 'qwen3:8b' ]
B status: RUNNING | ps: [ 'qwen3:8b' ]
after stop(B) -> ps: []
A status still: RUNNING | A health: {"status_code":200,"healthy":true,"status":"RUNNING"}
```
- 期望：按部署引用计数，或至少把共享该模型的其他部署同步标记为不再驻留。
- 实际：模型被全局卸载，A 仍显示 RUNNING 且 health 200，下一次请求需重新加载。
- 影响：状态误导、首次调用突然变慢；对「是否完全驻留内存」的核心不变量给出错误信号。

### DESK-08 退出/close 不回收子进程，Electron 退出后 llama-server 继续运行

- 严重程度：一般
- 位置：desktop/main.js:50-53（window-all-closed 只 local.close()，无 before-quit/will-quit）、desktop/server.js:157-175（close 只 server.close()）、deploy.js 无 shutdown/killAll
- 复现：start 一个 llama.cpp 部署，调 server.close()，看活动句柄：
```
after server.close(), active handle types: ["Server","Socket","Socket","Socket","Socket","Socket","ChildProcess"]
```
主进程退出后该子进程仍存活（上一条 DESK-03 中 76969 在父进程退出后仍在）。对 main.js 打桩后确认只注册了 activate / window-all-closed，没有 before-quit/will-quit，源码中无任何 .kill( 调用。
- 期望：退出时遍历部署 stop()/kill 子进程，并清理 pending 轮询定时器。
- 实际：无任何清理路径。
- 影响：关闭桌面端后后台仍有 llama-server 占内存/显存/端口，下次启动端口冲突。

### DESK-09 代理转发丢弃除 content-type 外的所有请求头

- 严重程度：一般
- 位置：desktop/server.js:45-57（init.headers 只放 content-type）
- 复现：起一个回显上游，经桌面端发带 authorization / x-custom / accept 的请求：
```
1) header-forward status 200
   upstream saw headers: {"host":"127.0.0.1:63701","connection":"keep-alive","content-type":"application/json","accept":"*/*",...}
```
authorization、x-custom 全部消失，accept 被换成 fetch 默认值。
- 期望：透传必要的请求头（authorization、accept、自定义头等）。
- 实际：只带 content-type。
- 影响：一旦控制面需要鉴权/内容协商/追踪头，代理会静默失败或行为异常。

### DESK-10 代理转发没有上游超时，控制面挂起时请求永久挂起

- 严重程度：一般
- 位置：desktop/server.js:45-57（fetch(SERVICE+req.url) 无 AbortSignal/timeout）
- 复现：上游对 /api/hang 永不响应，客户端 3s 超时：
```
3) upstream hang: client-aborted after 3004ms: The operation was aborted due to timeout
```
桌面端在 3s 内没有任何响应，也没有主动断开。
- 期望：给上游请求设置合理超时并返回 504/502。
- 实际：无限等待，占用连接与内存。
- 影响：控制面卡死时桌面端页面挂起，且每个挂起请求都累积。

### DESK-11 合法但非对象的 JSON 请求体导致 500（应为 400）

- 严重程度：一般
- 位置：desktop/server.js:125-135（/api/plans/preview）、server.js:137-147（/api/models/recommend）—— jsonBody 之后未校验 payload 是对象
- 复现：
```
9)  POST /api/plans/preview body=null     : 500 {"detail":"Cannot read properties of null (reading 'hardware')"}
10) POST /api/plans/preview body=123      : 500 {"detail":"Cannot create property 'hardware' on number '123'"}
11) POST /api/models/recommend body=null  : 500 {"detail":"Cannot set properties of null (setting 'hardware')"}
```
（/api/deployments 的同类输入返回 400，因为它包在 try 里。）
- 期望：非对象体返回 400「请求体必须是 JSON 对象」。
- 实际：抛异常被最外层 catch 成 500。
- 影响：错误分类错误，客户端可能按服务端故障处理；也说明这两条路由缺少与 deployments 一致的输入校验。

### DESK-12 端口冲突时 FAILED 部署的 health 误报 healthy:true

- 严重程度：一般
- 位置：desktop/deploy.js:361-371（health 只 fetch health_endpoint，不校验进程归属）
- 复现：两个 llama.cpp 部署抢同一端口 18103：
```
A {"status":"RUNNING","pid":75772,"port":18103}
B {"status":"FAILED","pid":null,"port":18103}
healthA {"status_code":200,"healthy":true,"status":"RUNNING"}
healthB {"status_code":200,"healthy":true,"status":"FAILED"}
```
- 期望：health 应结合状态/进程判断，FAILED 的部署不应报 healthy。
- 实际：B 命中的是 A 的 /health，因此报 200/healthy:true，尽管 B 自己的进程早已退出。
- 影响：用户以为 B 可用，实际 test() 会打到 A 的模型上；部署与模型错配。

### DESK-13 两个应用实例并发写 deployments.json 丢更新；main.js 无单实例锁

- 严重程度：一般
- 位置：desktop/deploy.js:65-72（整文件覆盖写，无锁/无合并）、desktop/main.js（没有 app.requestSingleInstanceLock）
- 复现：两个 Deployments 指向同一 dataDir，各自 create：
```
d1 created dep_..._1 | d2 created dep_..._1
file after both writes: [ 'B' ]
fresh reload sees: [ 'B' ]
=> item A lost: true
```
- 期望：加单实例锁；或写入前合并/使用带锁的原子写。
- 实际：后写者整文件覆盖，先写者的记录丢失。
- 影响：用户开两个窗口（或双击两次）会静默丢失部署记录。

### DESK-14 deployments.json 非原子写，损坏/截断后静默丢弃全部部署

- 严重程度：一般
- 位置：desktop/deploy.js:65-72（writeFileSync 直写目标文件）、deploy.js:46-63（catch 后从空开始）
- 复现：把文件写成截断内容（模拟写一半被杀）：
```
3) corrupt file -> threw: NO | items: 0
4) truncated file -> threw: NO | items: 0
```
- 期望：临时文件 + rename 原子替换；损坏时备份/告警而不是静默清空。
- 实际：不崩溃，但所有部署记录一次性丢失，用户无感知。
- 影响：断电/强杀可能丢失全部部署配置。

### DESK-15 不存在的部署：GET 返回 200 {}，动作返回 400 而非 404

- 严重程度：一般
- 位置：desktop/server.js:100-118、deploy.js:84-86（get 返回 {}）
- 复现：
```
3) GET  /api/deployments/nope        : 200 {}
4) POST /api/deployments/nope/start  : 400 {"detail":"Deployment nope not found"}
5) POST /api/deployments/nope/stop   : 400 {"detail":"Deployment nope not found"}
6) GET  /api/deployments/nope/health : 400 {"detail":"Deployment nope not found"}
```
- 期望：不存在资源返回 404；GET 单个不应返回 200 空对象。
- 实际：200 {} / 400。
- 影响：前端难以区分「部署存在但字段为空」和「不存在」。

### DESK-16 setWindowOpenHandler 把任意协议交给 shell.openExternal，且无 will-navigate 限制

- 严重程度：一般
- 位置：desktop/main.js:30-33（不校验 url 协议）、main.js 全文无 will-navigate / will-redirect
- 复现：对 main.js 打桩 Electron，触发 windowOpen：
```
3) windowOpen(https://example.com/) => {"action":"deny"} | openExternal: https://example.com/
3) windowOpen(file:///etc/passwd)   => {"action":"deny"} | openExternal: file:///etc/passwd
3) windowOpen(javascript:alert(1)) => {"action":"deny"} | openExternal: javascript:alert(1)
3) windowOpen(smb://evil/share)    => {"action":"deny"} | openExternal: smb://evil/share
```
- 期望：只允许 http/https 走 openExternal，其余协议拒绝；并加 will-navigate 白名单，只允许本地同源。
- 实际：所有协议都透传；页面也可整窗导航到任意远程地址（无 will-navigate）。
- 影响：恶意/被污染的链接可唤起本机 handler（如 smb:// 触发凭据泄露风险）；窗口可被导航到远程内容，破坏同源保证。

---

## B. 模拟故障输入下确认的解析/边界问题

（通过替换 execFile / 直接构造输入复现）

### DESK-17 llama.cpp 端口不校验，非法端口被接受

- 严重程度：轻微
- 位置：desktop/deploy.js:101（let port = Number(req.port) || 8000）
- 复现：
```
port 'abc': 8000
port 0: 8000
port 99999: 99999
port -1: -1
```
- 期望：端口限制在 1-65535，非法即拒绝。
- 实际：99999 / -1 被写入部署记录，启动时才在 spawn/listen 阶段失败。
- 影响：错误延后暴露；所有 llama.cpp 部署默认 8000，极易端口冲突（见 DESK-12）。

### DESK-18 ollama 创建时缺少 model_name 会写出 model_path=undefined

- 严重程度：轻微
- 位置：desktop/deploy.js:103-105
- 复现：
```
create ollama no model -> 200 {"id":"dep_...","port":11434}
after 4s status: FAILED | log: ["加载 undefined 到内存…","Ollama 返回 404：{\"error\":\"model '' not found\"}"]
```
- 期望：创建时校验 model_name/model_path 必填，返回 400。
- 实际：接受并在 start 时以 undefined 发起请求，日志出现「加载 undefined」。
- 影响：用户体验差、错误信息误导；不崩溃。

### DESK-19 本地路由不校验 HTTP 方法

- 严重程度：轻微
- 位置：desktop/server.js:71-85（/api/health、/api/hardware/self、/api/backends）
- 复现：
```
6) POST /api/hardware/self => 200
14) PUT  /api/hardware/self => 200
```
- 期望：非 GET 返回 405。
- 实际：任何方法都返回 200 并触发一次硬件探测。
- 影响：轻微，语义不严谨，可能被用来触发重复探测。

### DESK-20 _load 把 RUNNING/STARTING 改成 STOPPED，但不回写磁盘

- 严重程度：轻微
- 位置：desktop/deploy.js:46-63
- 复现：
```
2) in-memory after reload: dep_..._1:STOPPED:pid=null, dep_x:STOPPED:pid=null
   on-disk status still: dep_..._1:RUNNING:pid=12345, dep_x:STARTING:pid=999
```
- 期望：加载后立即 _save()，让磁盘与内存一致。
- 实际：只有后续发生写操作才会纠正。
- 影响：磁盘上的状态会误导外部读取者；下次加载会重复追加「应用重启…」日志。

### DESK-21 代理不透传上游响应头

- 严重程度：轻微
- 位置：desktop/server.js:53（只取 content-type）
- 复现：上游返回的 set-cookie / retry-after / x-request-id 等均不会出现在桌面端响应里（代码审查 + 回显上游验证 status/content-type 正常）。
- 期望：透传必要的响应头。
- 实际：只透传 content-type。
- 影响：控制面若依赖响应头（分页、限流、鉴权刷新），桌面端会丢失。

### DESK-22 macOS 页大小 fallback 固定 16384，Intel 机器上高估 4 倍

- 严重程度：轻微
- 位置：desktop/probe.js:62（Number(...) || 16384）
- 复现（桩替换 sysctl/vm_stat，350000 页）：
```
darwin pagesize MISSING + Intel 4K (350k pages): ram_avail=5.3
darwin pagesize 4096 present (same 350k pages): ram_avail=1.3
```
- 期望：拿不到 hw.pagesize 时不要假设 16384（Apple Silicon 专属），可回退 4096 或标记未知。
- 实际：Intel Mac 上若 sysctl 失败会把可用内存算成 4 倍。
- 影响：极端情况下推荐出本机装不下的模型。真机 sysctl 正常，属健壮性问题。

### DESK-23 GPU vendor 判定正则 m[1-4] 未覆盖 M5

- 严重程度：轻微
- 位置：desktop/probe.js:92（/apple|m[1-4] /i）
- 复现（桩替换 system_profiler）：
```
GPU name without 'Apple' prefix (M5 Max): gpus=[{"name":"M5 Max","vendor":"unknown","vram_gb":null,"uma":true}]
```
- 期望：覆盖 M1-M9 或直接以 sppci_vendor/spdisplays_vendor 判定。
- 实际：名字不含 apple 且为 M5 时 vendor=unknown。本机真实名字是 "Apple M5"，被 /apple/ 命中，所以真机未触发。
- 影响：潜在的错误分类，影响后续按 vendor 的规划逻辑。

---

## C. 代码审查怀疑（未在真机复现）

### DESK-24 hasBinary 的 execFile 没有 timeout

- 严重程度：轻微
- 位置：desktop/deploy.js:15-20
- 说明：execFile(which/where, [name]) 无 timeout。若 PATH 中有挂起的网络文件系统或包装脚本，detectBackends 会一直等待。probe.js 的 run() 有 8s timeout，deploy.js 这里没有，属不一致。
- 影响：/api/backends 可能永久挂起。

### DESK-25 readBody 没有大小上限

- 严重程度：轻微
- 位置：desktop/server.js:31-37
- 说明：把请求体全部读入内存且无上限。本机同源、风险低，但被恶意页面/本机进程利用可造成内存压力。
- 影响：内存放大。

### DESK-26 vm_stat 数值带千位分隔符时会解析错误

- 严重程度：存疑
- 位置：desktop/probe.js:71（parseInt）
- 复现（模拟输入）：
```
darwin vm_stat quoted keys + thousands separator: ram_avail=0
```
- 说明：真实 macOS 的 vm_stat 输出不带千位分隔符（本机实测 "Pages free: 12200."），因此真机不会触发；仅在本地化/格式变化时可能出错。parseInt 遇 "1,000" 只取 1。
- 影响：潜在，未确认。

### DESK-27 gb() 对极小非零值返回 0（falsy）

- 严重程度：存疑
- 位置：desktop/probe.js:31-34
- 说明：Math.round((n/1024**3)*10)/10 对小值会得到 0，而调用方常以 truthy 判断。模拟输入下 ram_avail 显示 0。
- 影响：可能把「极小但非零」误当成无数据；真机数值都较大，未触发。

### DESK-28 ram_available 的定义（free+inactive+speculative）可能低估可回收内存

- 严重程度：存疑
- 位置：desktop/probe.js:61-74
- 说明：未计入 purgeable / compressor 可回收部分。本机实测 7.3 GiB，与 free+inactive+speculative 一致，属可接受的近似，但不等同于「可用内存」的严格定义。
- 影响：容量判断偏保守；非 bug，仅提示。

---

## D. 验证为安全 / 正确的点（非问题，供对照）

- 参数化执行：模型名含 ;  $()  「反引号」  |  && 引号 时，假 ollama 记录到的 argv 都是**单个字面量**，未产生 /tmp/mdptest/pwned_model：
```
["pull","x; touch /tmp/mdptest/pwned_model"]
["pull","x$(touch /tmp/mdptest/pwned_model)"]
["pull","x`touch /tmp/mdptest/pwned_model`"]
["pull","x\" && touch /tmp/mdptest/pwned_model && echo \""]
["pull","x | touch /tmp/mdptest/pwned_model"]
B) pwned_model exists: false
```
- 路径穿越：/api/../../etc/passwd、/api/%2e%2e/%2e%2e/etc/passwd、/../../etc/passwd 原始请求行均返回桌面端 404，未转发给上游。
- execFile 超时生效：让 system_profiler sleep 20s，probe 在 8043ms 返回并回退到 CPU 名（Apple M5）。
- 探测数值正确（本机）：ram_gb=24（hw.memsize=25769803776）、cpu_cores=10（hw.ncpu=10）、cpu=Apple M5、model=Mac17,2、ram_available=7.3GiB（free 12200 + inactive 467365 + speculative 1680 页 × 16384）。
- PATH 为空：probe 不崩溃，字段变 null，GPU 回退 "Apple GPU"；detectBackends 仍能通过 HTTP 找到 ollama。
- Electron webPreferences 安全：contextIsolation:true、nodeIntegration:false、sandbox:true，无 preload。
- 冒烟：node smoke.js 12/12；node smoke.js --ollama qwen3:8b 16/16（含真机加载、对话、卸载）。

---

## 汇总表（按严重程度排序）

| 编号 | 标题 | 严重程度 | 位置 |
|---|---|---|---|
| DESK-01 | 控制面 plan command 被原样执行（RCE） | 严重 | deploy.js:297-328,241-252 |
| DESK-02 | 重复 start 泄漏无法回收的进程 | 严重 | deploy.js:134-146,252,266-274 |
| DESK-03 | 健康检查超时不杀子进程（孤儿） | 严重 | deploy.js:276-295 |
| DESK-04 | stop 只发 SIGTERM，忽略信号仍存活且谎报 STOPPED | 严重 | deploy.js:330-359 |
| DESK-05 | ollama pull 无超时、子进程不可管理 | 严重 | deploy.js:196-220 |
| DESK-06 | ollama 启动中 stop 被覆盖，回到 RUNNING | 严重 | deploy.js:156-183 |
| DESK-07 | 停止一个部署卸载共享 ollama 模型，另一个仍报 RUNNING | 一般 | deploy.js:342-354,361-371 |
| DESK-08 | 退出/close 不回收子进程（main.js 无 before-quit） | 一般 | main.js:50-53, server.js:157-175 |
| DESK-09 | 代理丢弃除 content-type 外的请求头 | 一般 | server.js:45-57 |
| DESK-10 | 代理无上游超时，请求永久挂起 | 一般 | server.js:45-57 |
| DESK-11 | 非对象 JSON body 返回 500（应 400） | 一般 | server.js:125-147 |
| DESK-12 | 端口冲突下 FAILED 部署 health 误报 healthy | 一般 | deploy.js:361-371 |
| DESK-13 | 双实例并发写 deployments.json 丢更新；无单实例锁 | 一般 | deploy.js:65-72, main.js |
| DESK-14 | deployments.json 损坏/截断后静默丢弃全部 | 一般 | deploy.js:46-72 |
| DESK-15 | 不存在部署返回 200 {} / 400（应 404） | 一般 | server.js:100-118 |
| DESK-16 | openExternal 任意协议；无 will-navigate | 一般 | main.js:30-33 |
| DESK-17 | 端口不校验（99999/-1） | 轻微 | deploy.js:101 |
| DESK-18 | ollama 无 model_name → model_path=undefined | 轻微 | deploy.js:103-105 |
| DESK-19 | 本地路由不校验 HTTP 方法 | 轻微 | server.js:71-85 |
| DESK-20 | _load 状态纠正不回写磁盘 | 轻微 | deploy.js:46-63 |
| DESK-21 | 代理不透传上游响应头 | 轻微 | server.js:53 |
| DESK-22 | macOS 页大小 fallback 16384 在 Intel 高估 4 倍 | 轻微 | probe.js:62 |
| DESK-23 | GPU vendor 正则 m[1-4] 未覆盖 M5 | 轻微 | probe.js:92 |
| DESK-24 | hasBinary 无 timeout | 轻微 | deploy.js:15-20 |
| DESK-25 | readBody 无大小上限 | 轻微 | server.js:31-37 |
| DESK-26 | vm_stat 千位分隔符解析（存疑） | 存疑 | probe.js:71 |
| DESK-27 | gb() 极小值返回 0（存疑） | 存疑 | probe.js:31-34 |
| DESK-28 | ram_available 定义偏保守（存疑） | 存疑 | probe.js:61-74 |

分布：严重 6、一般 10、轻微 9、存疑 3，合计 28。

## 测试环境清理

- 测试用假 llama-server / 假 ollama 进程已全部 kill，pgrep 无残留。
- ollama ps 为空（测试模型已卸载）。
- 未启动第二个 Electron 图形实例；未修改仓库源码；临时文件均在 /tmp/mdptest/ 下。

---

# 修复记录（server.js / main.js / probe.js / smoke.js）

- 范围：desktop/server.js、desktop/main.js、desktop/probe.js、desktop/smoke.js，
  新增 desktop/test-server.js；未触碰 deploy.js / installers.js / package.json /
  frontend / backend。
- 测试：`node test-server.js`（76 项，纯 node）、`node test-trust.js`（11 项）、
  `node smoke.js`（17 项）全绿。

## A 区（server.js）

| 编号 | 修法 |
|---|---|
| DESK-09 | forward() 改为透传客户端请求头：除 hop-by-hop（connection / keep-alive / transfer-encoding / upgrade / te / trailer / proxy-* / host / content-length）外全部带上去，authorization / accept / x-custom / user-agent 不再丢失。 |
| DESK-10 | 上游 fetch 加 AbortSignal.timeout（默认 30s，MDP_UPSTREAM_TIMEOUT_MS 可覆盖）；超时返回 504「上游控制面超时」，连接失败返回 502。读响应体阶段同样受该 signal 约束。 |
| DESK-11 | jsonBody() 校验解析结果是普通对象：null / 数组 / 数字 / 字符串一律 400「请求体必须是 JSON 对象」；非法 JSON 也统一成 400。 |
| DESK-15 | 所有 `/api/deployments/{id}...` 路由先查 `deploys.get(id).id`，不存在返回 404（GET / start / stop / health / test / DELETE 一致）。 |
| DESK-19 | `/api/health`、`/api/hardware/self`、`/api/backends` 只允许 GET；`/`、install、deployments 各动作与 `/api/plans/preview`、`/api/models/recommend` 都校验方法，不匹配返回 405 并带 Allow 头。 |
| DESK-21 | forward() 用 upstreamResponseHeaders() 回传上游响应头（至少 content-type、cache-control，以及 x-request-id 等）；因 fetch 已解压，剔除 content-encoding / content-length 等。 |
| DESK-25 | readBody() 加 1 MiB 上限，超限 413；超限后停止缓存并 drain 剩余 body，保证 413 能写回。 |

顺带：路径穿越（含 `%2e%2e` 编码形式）在进入代理前直接 404，不再转发上游（回归保留）。

## DESK-13（main.js 侧）

`app.requestSingleInstanceLock()`：拿不到锁的第二个实例直接 `app.quit()`；
第一个实例监听 `second-instance`，把已有窗口 restore + show + focus。
原有安全配置（contextIsolation:true / nodeIntegration:false / sandbox:true /
setWindowOpenHandler 的 http(s) 白名单 / will-navigate 本地同源白名单）保持不变，
test-server.js 里有 6 条静态断言守住。deploy.js 的整文件覆盖写不在本次所有权内，
单实例锁是「双实例并发写 deployments.json」的根治。

## probe.js（DESK-22/23/26/27/28 + Windows B/C）

- DESK-22：页大小不再写死 16384。优先 `sysctl -n hw.pagesize`，其次解析 vm_stat
  头部的 `page size of N bytes`，最后回退 4096（Intel 默认），绝不再假设 16K。
- DESK-23：新增 classifyGpuVendor()，正则覆盖 `m[1-9]`，并优先用 system_profiler
  的 vendor 字段；M5 等不含 "Apple" 前缀的名字也能判成 apple。
- DESK-26：vm_stat 解析前去掉千位分隔符。实测本机 `vm_stat` 输出不带逗号
  （见下），所以真机不是 bug，但这是低成本的健壮性修复。
- DESK-27：gb() 对正的极小值不再返回 0，而是下限 0.1，避免「有数据」被 falsy 误判。
- DESK-28：实测确认是定义问题而非 bug，**未改公式**（依据见下）。

### DESK-26/27/28 实测结论

在本机（Apple M5 / macOS 26.5.1 / Node v22.23.2）实测：

- vm_stat 输出 `Pages free: 13223.`，无千位分隔符；`parseInt` 正常。
  构造 `1,234,567.` 时旧逻辑得到 4（只取逗号前），去逗号后得到 1234567。
  → 真机无此 bug，去逗号是防御性修复。
- gb(1 byte)=0、gb(10MB)=0、gb(50MB)=0、gb(100MB)=0.1。
  → 正的极小值确实会变 0，修复为下限 0.1。
- 同一时刻 free 13772 + inactive 436833 + speculative 234 = 450839 页 ×16384
  ≈ 6.88 GiB；加上 purgeable 22684 页 ≈ 7.23 GiB；compressor 占用的 391833 页
  ≈ 6.0 GiB 是已经压缩驻留的物理页。当前定义取 free+inactive+speculative，
  是偏保守但成立的近似；purgeable 与 inactive 可能重叠，compressor 并非空闲，
  故不改公式，只在代码注释里写明取舍。

## Windows B / C（probe.js）

均为静态实现 + 纯函数单测（本机跑不了 Windows，未在真机执行）：

| 条目 | 修法 |
|---|---|
| B1 iGPU 当独显 | 新增 windowsGpuIsUma()：先排除 NVIDIA/RTX、Radeon RX/Pro/VII、Arc A/B 数字系列等独显，再判 Intel HD/UHD/Iris/Arc Graphics、Radeon Graphics/Vega、Adreno/Qualcomm/Snapdragon 以及 AMD 三位数+M 核显（780M/760M/680M/890M）为 UMA。UMA 卡 `vram_gb=null`，交给后端按系统内存算，避免 128MB carve-out。 |
| B2 vendor | 新增 classifyGpuVendor()，覆盖 nvidia / amd / intel / qualcomm / apple。 |
| B3 nvidia-smi 回退 | 依次尝试 `nvidia-smi`（PATH）、`%SystemRoot%\System32\nvidia-smi.exe`、`%ProgramFiles%\NVIDIA Corporation\NVSMI\nvidia-smi.exe`。 |
| B4 多路 CPU | Win32_Processor.Name 去重后用 ` + ` 连接，不再只取第一行。 |
| B5 Windows ARM64 | 无 nvidia-smi 时走注册表/CIM 路径，Adreno 被判为 UMA + qualcomm，内存按系统内存计。 |
| C WSL2 | 新增 detectWsl() 读 `/proc/version` 是否含 microsoft/wsl；命中时输出 `wsl:true` 与 `wsl_note`，提醒 /proc/meminfo 是 WSL 限额。 |

商标归一化：`normalizeGpuName()` 去掉 `(TM)/(R)/(C)` 与 ™®©、压平空白后再匹配，
因此 `AMD Radeon(TM) Graphics` 能正确判成 UMA，而 `Intel(R) Arc(TM) A770 Graphics`
归一化后仍命中独显规则。AMD 三位数+M 核显（`AMD Radeon 780M` 等）单独加了 `/\b\d{3}m\b/`，放在独显判断之后；`RX 7600M`（四位数字）不会命中。

## Windows F（smoke.js）

`usable_vram_gb > 10.5` 改为相对断言：先由 `/api/hardware/self` 推出本机容量
（UMA 取 ram_gb，独显取最大 vram），再断言 plan 的 usable_vram_gb > 0 且不超过
该容量。M5 上显示 `usable=19.2GB (self ram=24GB, capacity=24GB)`，小显存机器也能过。

## 新增测试

`desktop/test-server.js`（纯 node，76 项）覆盖：readBody 413、非对象 body 400、
缺失部署 404、方法不匹配 405、代理超时 504、请求/响应头透传、路径穿越 404、
main.js 安全静态断言，以及 probe 纯函数（vendor / UMA / 注册表 / nvidia-smi /
vm_stat / 页大小回退）。跑法：`cd desktop && node test-server.js`。
