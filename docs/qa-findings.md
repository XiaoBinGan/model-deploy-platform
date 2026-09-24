# QA 汇总报告 · model-deploy-platform

三个独立子代理分别测试后端控制面、Electron 桌面端、前端页面与端到端流程。
分支 feat/client-hardware-profile。**只记录问题，未修改任何源码。**

## 总览

| 范围 | 明细报告 | 严重 | 一般 | 轻微 | 存疑 | 合计 |
|---|---|---:|---:|---:|---:|---:|
| 后端控制面 backend/ | docs/qa-findings-backend.md | 4 | 12 | 6 | 2 | 24 |
| 桌面端 desktop/ | docs/qa-findings-desktop.md | 6 | 10 | 9 | 3 | 28 |
| 前端 frontend/ | docs/qa-findings-frontend.md | 1 | 7 | 5 | 2 | 15 |
| **合计** | | **11** | **29** | **20** | **7** | **67** |

基线：pytest 31 passed；node smoke.js 12/12；node smoke.js --ollama qwen3:8b 16/16。

## 修复状态

已修 9 条（含 5 条严重），提交 9375c19。

| 编号 | 严重程度 | 修复方式 | 回归测试 |
|---|---|---|---|
| F-01 | 严重 | esc() 补 > " ' 转义；下拉改用索引 + DEPLOY_MODELS，不再把 JSON 塞进属性 | smoke: esc 转义 / 下拉守卫 |
| B-02 | 严重 | 部署 ID 改用 uuid4 | test_deployment_ids_are_unique_within_the_same_second |
| B-03 | 严重 | command_string 改用 shlex.join | test_command_string_escapes_model_path |
| DESK-02 | 严重 | start() 拦 STARTING，重复启动幂等 | 假 llama-server 验证（procs.size==1） |
| DESK-03 | 严重 | 健康检查超时后真的 kill 进程 | _kill 单元验证 |
| DESK-04 | 严重 | stop() SIGTERM 后宽限期到就 SIGKILL，确认死亡才报 STOPPED | 假 llama-server 忽略 SIGTERM 验证 |
| DESK-05 | 严重 | ollama pull 注册进 procs 并加 30 分钟超时 | 代码审查 |
| DESK-06 | 严重 | 世代计数让 stop 后的旧启动结果无法翻回 RUNNING | 世代过期验证 |
| DESK-08 | 一般 | 新增 stopAll()，接进 server.close 与 before-quit | 假 llama-server 验证 |

### 第二轮：信任边界（已修）

已修 5 条，提交见 git log。设计原则定为「**控制面是提示源，不是命令源**」——
服务端只提供数字和文本，不提供可执行的东西。完整说明见 docs/trust-boundary.md。

| 编号 | 严重程度 | 修复方式 | 回归测试 |
|---|---|---|---|
| DESK-01 | 严重 | argv 一律本地拼；服务端只贡献一个整数（上下文窗口），经 safeWindow 夹在 1024~1048576。警告压平换行防日志伪造。端口加 1024~65535 校验 | desktop/test-trust.js（敌对服务返回 command，断言从未执行） |
| B-01 | 严重 | 默认不装 CORS 中间件（页面本来就同源）；需要时用 MDP_CORS_ORIGINS 显式开 | test_trust_boundary.py（6 条） |
| B-04 | 严重 | _require_local() 加到全部 5 个写操作；读操作保持开放 | test_trust_boundary.py（12 条参数化） |
| B-12 | 一般 | Host 头只在确实指向本机时回显，否则用本机地址替换 | test_trust_boundary.py（3 条） |
| DESK-16 | 一般 | openExternal 只放行 http/https；新增 will-navigate 阻止窗口被导航离开 | 代码审查 + app 启动验证 |

**为什么不是加 token**：控制面本来就不该有权指定客户端执行什么。
把 argv 收归本地之后，DESK-01 直接消失，不需要引入 token 机制，
也不需要回答「控制面是不是本机专属」这个问题——两种部署形态都安全。

**~~已记录但未修~~ 已修**：B-08（plan_window 对 native 小于 64K 的模型返回 64K）
当初在 backend/tests/test_qa_regressions.py 里标记为 xfail strict 作为提醒。
后来已修复（`best = min(floor, cap)`），xfail 标记已删除，断言保留为正常测试。
`qwen3-8b` 的 `--max-model-len` 由 65536 变为 32768。详见第六节。

## 一、11 条严重问题

| 编号 | 标题 | 位置 |
|---|---|---|
| B-01 | CORS 全开 * 且只信任 TCP 回环，任意网页可 drive-by 创建并启动部署 | backend/app/main.py:20-25,67-69 |
| B-02 | 部署 ID 用秒级时间戳，同秒创建互相覆盖，记录静默丢失 | backend/app/services/deployments.py:46 |
| B-03 | command_string 用空格拼接未转义，model_path 可注入命令 | backend/app/services/planner.py:129-161 |
| B-04 | remote 403 只保护创建，start/stop/test/health/list 无任何校验 | backend/app/main.py:212-239 |
| DESK-01 | 控制面返回的 plan command 被原样 spawn，可导致本机任意命令执行 | desktop/deploy.js:297-328,241-252 |
| DESK-02 | STARTING 期间重复 start 泄漏无法回收的 llama-server | desktop/deploy.js:134-146,252,266-274 |
| DESK-03 | 健康检查 90s 超时只改状态不杀进程，留下孤儿 | desktop/deploy.js:276-295 |
| DESK-04 | stop 只发 SIGTERM，进程忽略信号仍存活却谎报 STOPPED | desktop/deploy.js:330-359 |
| DESK-05 | ollama pull 无超时且子进程不入 procs，stop 管不到 | desktop/deploy.js:196-220 |
| DESK-06 | ollama 启动中 stop 被 in-flight generate 覆盖，状态回到 RUNNING | desktop/deploy.js:156-183 |
| F-01 | 部署下拉 option.value 被双引号截断，模型选择/推荐联动/usePick 全失效 | frontend/index.html:401 |

## 二、按根因聚类

67 条里很多是同一个根因的不同表现。按根因修比按条目修划算得多。

### 聚类 1：部署 ID 不唯一（3 条）

B-02 是源头。秒级时间戳意味着「同一秒内创建的所有部署是同一个对象」。
前端 F-08、桌面端 DESK-13（双实例并发写 deployments.json）都是它的下游表现。
实测：连续 3 次 create 得到同一个 id，distinct=1，只剩最后一个。

修：换成 uuid4 或自增计数。

### 聚类 2：子进程生命周期无人管理（6 条）

DESK-02/03/04/05/06/08 全部围绕 desktop/deploy.js 里的 procs Map。
start / close / stop 三处对它做无条件增删，没有状态机保护，于是：

- STARTING 期间重复 start 会 spawn 两个进程，后一个覆盖前一个的引用
- 超时和 stop 都不保证进程真的死掉
- 退出应用不回收子进程

后果是显存不释放、端口不释放、状态和现实不一致。用户点「停止」以为停了，其实没停。

修：给部署加明确状态机（IDLE/STARTING/RUNNING/STOPPING/FAILED），
所有状态迁移走同一个入口；进程退出统一用 SIGTERM 后延迟 SIGKILL；
应用退出时 before-quit 里遍历 procs 全部回收。

### 聚类 3：信任边界（5 条）

B-01、B-04、DESK-01、DESK-16，加上 B-12（Host 头驱动 SSRF）。

共同点是「谁可以指挥这个系统」没有定义清楚：

- 控制面 CORS 全开，且只按 TCP 回环判断本机，浏览器请求天然满足
- remote 403 只挡了创建，没挡启动/停止/推理
- 桌面端把控制面返回的 argv 当可信输入直接 spawn
- 桌面端的 openExternal 接受任意协议

修：需要先做一个设计决定——控制面到底是不是「本机专属」。
如果是，就绑死 127.0.0.1、关掉 CORS 通配、加本机 token；
桌面端对 command[0] 做白名单（只允许 llama-server）。

### 聚类 4：字符串转义（3 条）

B-03（后端 command_string 未转义）、F-01、F-02（前端 esc 不转义引号）。

F-01 和 F-02 是同一个函数的问题：esc() 只转义 & 和 <，不转义引号。
F-01 导致 option.value 被截断（功能失效），F-02 允许属性注入（安全问题）。

修：esc 补上引号转义，或改用 textContent / dataset 赋值而不是拼 HTML 字符串。

### 聚类 5：输入校验缺失（8 条）

B-05（NaN/Infinity 触发 500）、B-06（gpus 非列表 500）、B-07（available_vram_gb 未钳制，
填 100000 得到 usable 100000GB 大于 total 24GB）、B-10（port 0/-1/70000 全接受）、
DESK-11、DESK-17、F-10、DESK-25（readBody 无大小上限）。

修：在 API 边界统一做类型+范围校验，Pydantic 层加 Field(ge=, le=)。

### 聚类 6：状态与错误处理（7 条）

F-03（后端不可用时状态行永久停在「正在检测」）、F-04/F-05（无 try/catch 导致
unhandled rejection）、B-09/B-15（不存在部署返回 200 空对象而非 404）、
B-13（STOPPED 部署仍报 healthy）、DESK-12（端口冲突下 FAILED 仍报 healthy）。

修：统一「查不到就是 404」，health 必须反映真实状态而不是「对象存在」。

## 三、建议修复顺序

| 优先级 | 内容 | 理由 |
|---|---|---|
| P0 | F-01（esc 补引号 + 修 option value） | 一行改动，恢复「选模型自动填路径」这条核心链路 |
| P0 | B-02（部署 ID 换 uuid） | 几行改动，消除一整类数据丢失 |
| P1 | 聚类 2（子进程状态机） | 改动集中在一个文件，解决 6 条严重问题 |
| P1 | B-03（shlex.join） | 一行改动，消除复制即执行的风险 |
| P2 | 聚类 3（信任边界） | 需要先定设计，再动手 |
| P3 | 聚类 5、6（校验与错误处理） | 量大但每条独立，可增量做 |

## 四、已验证正确的部分（不是问题）

三个子代理都单独列了「验证通过」清单，这些是可靠的：

- 探测数值正确：24GiB / 10 核 / 7.3GiB 可用 / Apple M5，与 sysctl、vm_stat 一致
- 无 shell 注入：模型名含分号、反引号、管道、命令替换时，argv 都是单个字面量
- 路径穿越被拦：/api/../../etc/passwd 与 %2e%2e 变体全部 404，未转发上游
- execFile 超时生效：挂起 20s 的 system_profiler 在 8s 被切断
- Electron 安全配置正确：contextIsolation + sandbox，无 preload
- 思考模型修复有效：reply_source=reasoning 与 hint 渲染正确且已转义，max_tokens 默认 512 生效
- runTest / renderRows 对 img onerror 正确转义，无 XSS
- 单页重构本身没有回归：getElementById 与 HTML id 双向差集为 0，
  onclick/onchange 函数全部有定义，无 show()/renderBanner/wizard 残留，
  jump('profile') 正确展开，4 个 details 都能渲染，720/520/400px 无横向溢出

最后一条值得强调：**单页重构是干净的**。前端那路专门做了回归检查，
双向差集为 0，说明重构没有改坏东西。F-01 这条核心链路 bug 早于重构
（git blame 指向 ffdf998），只是这次才被测出来。

## 五、测试盲区

现有 31 个后端测试 + 16 项桌面冒烟，一条都没覆盖：

1. HTTP 层错误映射（没有 TestClient/httpx 级别的路由测试）
2. 输入数值健壮性（非有限浮点、类型错误、范围越界）
3. 命令字符串安全（只断言了 argv 列表）
4. 并发与唯一性（部署 ID 唯一性）
5. 子进程生命周期（重复启动、超时、信号）
6. 跨源/信任边界
7. 前端 DOM 层（没有任何前端测试）

这是这些问题能藏到现在的直接原因。

---

## 六、最终状态：67 条全部处理（协调者回填）

上面第一~五节是**修复前**的原始记录，保留不改，便于对照。
本轮（feat/client-hardware-profile）之后的状态如下。

| 范围 | 明细报告 | 条数 | 最终状态 |
|---|---|---:|---|
| 后端控制面 | `docs/qa-findings-backend.md` §6 | 24 | **24/24 已处理** |
| 桌面端 | `docs/qa-findings-desktop.md` 末节 | 28 | **26 已修 + 1 非 bug（DESK-28）+ 1 防御性修复（DESK-26）** |
| 前端 | `docs/qa-findings-frontend.md` §7 | 15 | **13 已修 + S1 已修 + S2 攻击路径消失** |
| **合计** | | **67** | **全部有结论** |

三份明细报告各自新增了逐条状态表（含「已修 / 非 bug / 未验证」三态和证据），
独立的证伪复查见 `docs/qa-round3.md`（该报告又找出 12 条问题，也已全部处理）。

### 测试盲区已经补上

第五节列出的 7 个盲区，现在都有对应测试：

| 盲区 | 现在覆盖它的测试 |
|---|---|
| 1. HTTP 层错误映射 | `backend/tests/test_deploy_api_contract.py`、`test_trust_boundary.py` |
| 2. 输入数值健壮性 | `test_qa_regressions.py`、`test_client_hardware.py` |
| 3. 命令字符串安全 | `test_core.py`、`test_planner_platform.py`、`desktop/test-trust.js` |
| 4. 并发与唯一性 | `test_qa_regressions.py`（uuid 唯一性）、`test_deployments_resilience.py` |
| 5. 子进程生命周期 | `desktop/test-docker.js`（含忽略 SIGTERM 的 SIGKILL 用例）、`test-mlx.js` |
| 6. 跨源/信任边界 | `test_trust_boundary.py`、`desktop/test-trust.js`（含 docker 用例） |
| 7. 前端 DOM 层 | `desktop/test-frontend.js`（真 Electron 加载 index.html，37 项） |

### 仍然无法验证的（不要当成已完成）

1. **Windows 真机行为**——所有 Windows 相关代码是静态实现 + 纯函数单测，
   本机 macOS 跑不了。详见 `docs/windows-gaps.md`。
2. **真实容器集成**——本机 Docker Desktop 已安装但守护进程未运行；
   docker 执行路径用假二进制测（`desktop/test-docker.js`，89 项），**没有跑过真容器**。
3. **Windows 安装包**——nsis 配置已写，没有在 Windows 上构建或运行过。
4. **macOS 公证**——打包产物未做 notarization。

