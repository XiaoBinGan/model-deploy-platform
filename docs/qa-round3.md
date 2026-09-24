# QA Round 3 · 独立证伪报告

> 验证者：独立子代理（只读）。仓库 `/Users/supre/Documents/tmp/model-deploy-platform`，
> 分支 `feat/client-hardware-profile`。
> 本轮**未修改任何源码或测试**；唯一新增文件是本报告。所有临时脚本通过 `node <<'NODE'` /
> `python - <<'PY'` 走 stdin，临时数据在 `/tmp`。
> **重要前置事实**：开始验证时工作区确实是未提交状态；验证中途仓库出现了一个新提交
> `7d77463`（作者 吴佳浩，时间 2026-09-24 15:11:56）。因此本报告用 `HEAD~1 = 2c13be2` 作为
> 「旧代码」，而不是 `git show HEAD:<file>`。旧代码不再能从工作区取，只能从 git 历史取。

## 一句话结论

**Docker 契约两侧并不一致（`--name` 与镜像名大小写两处会生成不同 argv），控制面创建入口会
静默清洗 image 首尾空白（违反契约 §5「拒绝，不清洗」）；但信任边界仍然成立，Docker 校验没有
发现可执行的注入绕过。** 测试整体是实打实的（新测试在旧代码下 32+ 条失败），但存在
DESK-04（SIGTERM 忽略→SIGKILL）**零覆盖**、2 条 Docker 测试在旧代码下也通过、以及旧测试被
改成更松断言的问题。

## 按严重程度排序

| 编号 | 标题 | 严重程度 | 证据（命令 + 实际输出） | 位置 |
|---|---|---|---|---|
| R3-01 | Docker `--name` 两侧不一致：桌面端用部署 id，控制面用 model_id slug；预览的名字永远对不上真实容器 | 一般 | 见下方「R3-01 证据」。桌面端 argv 为 `mdp-dep_1790233758443_1`；控制面 argv 为 `mdp-qwen3-8b`。契约 §4 要求两侧同形状，`planner._docker_slug` docstring 还声称「桌面端用同样的名字 rm -f」——事实是桌面端从不使用 slug | `desktop/deploy.js:856,417`；`backend/app/services/planner.py:167-175,226,363` |
| R3-02 | 镜像家族判定大小写不一致：控制面 `image.lower()`，桌面端 `indexOf("vllm")` 区分大小写 → 同一镜像名两侧端口/参数不同 | 一般 | `VLLM/VLLM-OPENAI:LATEST`：控制面 → container_port=8000 + `--model/--max-model-len`；桌面端 → container_port=8080 且不加任何镜像专属参数。`SGLANG/SGLANG:LATEST`：控制面 30000+sglang 参数，桌面端 8080 无参数 | `planner.py:143-148`；`desktop/deploy.js:84-87,876-882` |
| R3-03 | 控制面 `POST /api/deployments` 静默清洗 image 首尾空白/制表符，违反契约 §5「拒绝，不清洗」；同一输入 `/api/plans/preview` 与桌面端都拒绝 | 一般 | 见「R3-03 证据」。`image=" vllm/x:latest"` / `"\tvllm/x"` 经 HTTP 创建返回 **200** 且存成 `vllm/x:latest`；preview 返回 400「非法镜像名」。桌面端 `validateDockerFields` 也 400 | `backend/app/services/deployments.py:135` |
| R3-04 | DESK-04（进程忽略 SIGTERM → 宽限后 SIGKILL）**没有任何测试覆盖**；所有假进程收到 SIGTERM 都主动退出，SIGKILL 分支永远走不到 | 一般（覆盖缺口） | 见「R3-04 证据」。grep 全部 desktop 测试，3 处 SIGTERM 处理全是 `process.exit`/`server.close`；直接给 `_kill` 喂忽略 SIGTERM 的子进程可证明修复有效（1307ms 内被杀） | `desktop/deploy.js:603-630`；测试见 `desktop/test-docker.js:112`、`test-trust.js:75`、`test-mlx.js:65` |
| R3-05 | `test-trust.js` 的敌对控制面用例只覆盖 llama.cpp，**没有 docker 用例**；Docker 路径的信任边界未进回归 | 一般（覆盖缺口） | `grep -n "docker" desktop/test-trust.js` 无输出。我自建敌对控制面验证 Docker 路径**没有**被攻破（见 R3-05 证据） | `desktop/test-trust.js`（全文） |
| R3-06 | 2 条「Docker 校验」测试在旧代码下也通过，属于弱测试/假绿 | 轻微 | `test_docker_gpus_none_omits_the_gpus_flag_entirely` 与 `test_non_docker_backend_ignores_docker_fields` 在 2c13be2 下 PASSED。前者在旧 planner 上必然通过（旧代码根本没有 docker 分支，命令里永远没有 `--gpus`），所以它**没有**测到「docker 且 gpus=none」这条规则 | `backend/tests/test_planner_docker.py:50,216` |
| R3-07 | 桌面端对 Docker 的越界端口静默回退 8000，而契约 §5 说非法值拒绝；控制面同一输入 400 | 轻微 | 桌面端 `create({port:99999})` → 200/内存对象 port=8000（见 R3-07 证据）；控制面 preview `port=99999` → 400 | `desktop/deploy.js:524`；`planner.py:217` |
| R3-08 | 旧测试被改松：`test_local_deploy_is_allowed` 删掉状态断言；B-08 的窗口断言下界从 `>=65536` 变成 `>=1`，下界形同虚设 | 轻微 | 见「R3-08 证据」的 git diff。改动方向合理（旧断言在新行为下必红），但 `1 <= window` 几乎不构成不变量 | `backend/tests/test_client_hardware.py:32-37`、`backend/tests/test_core.py:36-42` |
| R3-09 | Windows 纯函数：老一代 AMD APU 核显被判成独显（`uma=false`），会用注册表小 carve-out 当显存 | 轻微 | `windowsGpuIsUma("AMD Radeon R7 Graphics")` → false；`("AMD Radeon R5 Graphics")` → false；`("AMD Radeon HD 8650G")` → false；`("AMD Radeon HD 7660G")` → false。已知历史三坑（Radeon(TM) Graphics / 780M / Arc A770）**全部正确** | `desktop/probe.js:91-110` |
| R3-10 | `classifyGpuVendor("Arc A770")`（不带 Intel）→ `unknown`；`classifyGpuVendor("Microsoft Basic Display Adapter")` → `unknown` | 轻微 | 见 R3-09 证据表。Windows DriverDesc 一般含 "Intel(R)"，但第三方工具可能只报 "Arc A770" | `desktop/probe.js:77-85` |
| R3-11 | `test_transformers_server_stream.py` 有一条断言用 `inspect.getsource` 检查源码字符串，是代码形状测试而非行为测试 | 轻微 | `assert "text/event-stream" in source` / `assert "JSONResponse" not in source`；同文件另有真正的行为测试 `test_stream_true_produces_sse_frames` | `backend/tests/test_transformers_server_stream.py:27-31` |
| R3-12 | 「所有改动都在工作区、未提交」这一前提**已不成立** | 存疑/事实变更 | 验证中途 `git reflog` 出现 `7d77463 HEAD@{0}: commit: feat: Docker 部署后端 + 修复剩余 QA 发现（后端 24 条全部处理）`，时间 2026-09-24 15:11:56。工作区随后变干净 | 仓库 git 状态 |

## 已验证（声明成立，附证据）

| 编号 | 声明 | 结论与证据 |
|---|---|---|
| A2 | `gpus=="none"` 时整条 `--gpus` 省略（两侧） | **已验证**。桌面端 `argv none` 无 `--gpus`；控制面 `none` argv 无 `--gpus`。见「A2/A3 证据」 |
| A3 | 用户 volumes 已有 `container=="/hf"` 时跳过自动挂载（两侧） | **已验证**。两侧都只出现一条 `-v <用户host>:/hf`，没有 `~/.cache/huggingface:/hf`；`-e HF_HOME=/hf` 保留 |
| A4 | `container_port` 按镜像名子串推断（小写） | **已验证**。vllm→8000、sglang→30000、其它→8080，两侧一致；**但大小写变体不一致见 R3-02** |
| B5/B6 | image/gpus/volumes/extra_args 校验拦得住恶意输入（无绕过） | **大部分已验证**。空格/分号/反引号/`$()`/管道/换行/NUL/超长/类型混淆/相对路径/不存在 host/>8 volume/>32 extra_arg 在**两侧**均被拒；argv 用数组 spawn/execFile，不过 shell。**唯一例外是 R3-03 的空白清洗** |
| C7/C8 | 桌面端只从控制面取一个整数窗口，Docker 参数来自本地 UI | **已验证**。敌对控制面返回 `command:[evil.sh]` + `decision.docker.image:"evil/image:latest"`，桌面端实际执行的是本地 UI 的 `vllm/vllm-openai:latest`，evil 未执行，窗口 32768 生效，警告换行被压平。见 R3-05 证据 |
| E12（历史三坑） | `'AMD Radeon(TM) Graphics'`、`'AMD Radeon 780M'`、`'Intel(R) Arc(TM) A770'` | **已验证**。分别 → `uma=true/amd`、`uma=true/amd`、`uma=false/intel` |
| F14 | 创建→启动→健康→删除（真实 HTTP） | **已验证**。见 F14 证据：docker 守护进程未运行时诚实报 FAILED（不是假 RUNNING），health=false，delete 后列表清空 |

## 关键证据原文

### R3-01 证据（`--name` 不一致）

```
$ node <<'NODE'   # require desktop/deploy.js, create docker, print _dockerArgv
argv vllm: ["docker","run","--rm","--name","mdp-dep_1790233758443_1","-p","127.0.0.1:8000:8000", ...]

$ backend/.venv/bin/python - <<'PY'   # planner._docker_argv
vllm_all {"container_port": 8000, "argv": ["docker","run","--rm","--name","mdp-qwen3-8b", ...]}
```

桌面端 `_dockerRemove` 删除的也是 `"mdp-" + item.id`（deploy.js:417），因此桌面端自洽；
**不一致的是控制面预览**。`test-docker.js:164` 断言 `"mdp-" + a.id`，
`test_planner_docker.py:37` 断言 `"mdp-qwen3-8b"`——两边各自锁死了自己的约定，
**没有一条测试做跨侧对比**。

### R3-02 证据（大小写）

```
$ node ... _dockerArgv(mk({image:"VLLM/VLLM-OPENAI:LATEST"}), 32768)
argv UPPER: [...,"127.0.0.1:8000:8080",...,"VLLM/VLLM-OPENAI:LATEST"]   container_port= 8080
$ python ... probe(image="VLLM/VLLM-OPENAI:LATEST")
UPPER {"container_port": 8000, "argv": [...,"127.0.0.1:8000:8000",...,"VLLM/VLLM-OPENAI:LATEST","--model","G:/models/Qwen3-8B","--host","0.0.0.0","--port","8000","--max-model-len","32768"]}
```

### R3-03 证据（控制面创建清洗空白）

```
$ MDP_ALLOW_REMOTE_DEPLOY=1 python - <<'PY'  (TestClient POST /api/deployments)
lead-space 200 {... 'backend':'docker' ...}
$ python - <<'PY'  (POST /api/plans/preview, image=" vllm/x:latest")
REJECT image-lead-space | 400 | 非法镜像名: ' vllm/x:latest'
```

源码：`deployments.py:135` `image = image.strip() if isinstance(image, str) else ""`。
`planner._validate_docker` 与桌面端 `validateDockerFields` 都没有 `.strip()`。
同一份契约、同一台机器、三个入口，两个拒绝一个接受。

### R3-04 证据（DESK-04 零覆盖）

```
$ grep -rn "SIGTERM" desktop/test-*.js
test-docker.js:112:    '  process.on("SIGTERM", function () { process.exit(0); });',
test-mlx.js:65:process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
test-trust.js:75:    "process.on(\"SIGTERM\", () => s.close(() => process.exit(0)));",
```

三处假进程都主动退出，`_kill` 的 `SIGKILL` 分支永不触发。直接验证修复有效：

```
$ node ... spawn(node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"), then d._kill(child,1000)
pid 28555 alive_after_kill false elapsed_ms 1307
```

### R3-05 证据（Docker 信任边界 + test-trust 无 docker）

```
$ grep -c docker desktop/test-trust.js
0
$ node ... hostileService({command:[evil], decision:{planned_window:32768, docker:{image:"evil/image:latest"}}})
STATUS RUNNING
DOCKER_CALLS [["rm","-f","mdp-dep_..."],["run","--rm","--name","mdp-dep_...","-p","127.0.0.1:8961:8000","-e","HF_HOME=/hf","-v","/Users/supre/.cache/huggingface:/hf","vllm/vllm-openai:latest","--model","Qwen/Qwen3-8B","--host","0.0.0.0","--port","8000","--max-model-len","32768"]]
MARKER_EXISTS false
LOG [...,"警告：伪造   PASS  我骗过了测试",...]
```

结论：Docker 路径的边界**没有被破坏**（image 来自本地 UI，只有窗口整数被采纳），
但 `test-trust.js` 里没有这条回归。

### R3-06 证据（旧代码下也通过的 Docker 测试）

```
$ cd /tmp/qa3-old/backend && <venv>/python -m pytest -q -rA --tb=no | grep PASSED | grep test_planner_docker
PASSED tests/test_planner_docker.py::test_docker_gpus_none_omits_the_gpus_flag_entirely
PASSED tests/test_planner_docker.py::test_non_docker_backend_ignores_docker_fields
```

同一次运行里 `test_planner_docker.py` 其余 30 条全部 FAILED，说明这两条确实没测到新分支。

### R3-07 证据（桌面端口静默回退）

```
$ node ... d.create({backend:"docker",...,port:99999})
ACCEPT port-99999 | argv= [...,"-p","127.0.0.1:8000:8000",...]
ACCEPT port-negative | argv= [...,"-p","127.0.0.1:8000:8000",...]
$ python ... preview(port=99999)
REJECT port-99999 | 400 | port 必须在 1024~65535
```

### R3-08 证据（旧测试改松）

```
$ git diff HEAD~1 HEAD -- backend/tests/test_client_hardware.py backend/tests/test_core.py
-test_client_hardware.py
-    dep = main.create_deployment(...)
-    assert dep["status"] == "CREATED"
+    main.create_deployment(...)          # 断言被删除
-test_core.py
-    assert out["decision"]["planned_window"] >= 65536
+    assert 1 <= out["decision"]["planned_window"] <= entry.native_ctx
```

### R3-09 / R3-10 证据（Windows 纯函数）

```
$ node <<'NODE'  (probe.js)
"AMD Radeon(TM) Graphics"        uma= true   vendor= amd
"AMD Radeon 780M"                uma= true   vendor= amd
"AMD Radeon Vega 8 Graphics"     uma= true   vendor= amd     # 靠 vega\s?\d 兜住
"AMD Radeon R7 Graphics"         uma= false  vendor= amd     # 老 APU，误判为独显
"AMD Radeon R5 Graphics"         uma= false  vendor= amd
"AMD Radeon HD 8650G"            uma= false  vendor= amd
"AMD Radeon HD 7660G"            uma= false  vendor= amd
"Intel(R) Arc(TM) A770"          uma= false  vendor= intel   # 正确
"Intel(R) Arc(TM) Graphics"      uma= true   vendor= intel   # 核显 Arc，正确
"Qualcomm(R) Adreno(TM) 680"     uma= true   vendor= qualcomm
"Arc A770"                       uma= false  vendor= unknown # 无 Intel 前缀
```

### F14 证据（真实 HTTP 生命周期）

```
CREATE 200 {"id":"dep_1790234467182_1","status":"CREATED","image":"vllm/vllm-openai:latest","container_port":8000,...}
START 200 {...}
AFTER_START FAILED | log tail: ["docker rm -f 未删除容器：Cannot connect to the Docker daemon...","docker run 退出，code=125"]
HEALTH 200 {"deployment_id":"dep_1790234467182_1","healthy":false,"status":"FAILED"}
DELETE 200 {"id":"dep_1790234467182_1","deleted":true}
LIST_AFTER_DELETE {"deployments":[]}
```

控制面在 127.0.0.1:8790（`/api/health` 返回 `service=model-deploy-platform`），
桌面端在 127.0.0.1:50151（`/api/health` 返回 `"mode":"desktop"`）。

## 「无法证实」清单

找不到证据支持、也没找到反例：

1. **electron-builder 打包产物**（Resources/frontend/index.html 是否存在、asar 白名单）——按指示划给上级，本轮未验证。
2. **Electron 测试** `test-frontend.js` / `test-backend-ui.js`——本机同一时刻只能跑一个 Electron，验证期间用户 app（Electron PID 21923）在跑，未启动。因此「前端 Docker 区块显隐/请求体」未经我独立复验。
3. **Windows nvidia-smi 回退与 WSL2 检测**——`probeWindows`/`detectWsl` 依赖 Windows 与 `/proc/version`，本机（macOS）无法执行；只做了逻辑审读，未运行。
4. **vLLM gaps 5/6/7 的每一条**——只验证了与 planner 相关的 gap 6（CUDA flag 在非 NVIDIA 平台省略，见 `test_planner_platform.py`，新测试在旧代码下失败），其余 gap 未逐条复验。
5. **「67 条 QA 发现大部分已修」**——未逐条核对；本轮只抽样验证了 B-08/B-09/docker 校验/DESK-04，以及新测试整体在旧代码下 111 FAILED。
6. **提交 7d77463 是谁在何时创建的**——reflog 只显示作者/时间，无法证明是否覆盖了我开始验证时的某个中间状态。

## 验证方法（实际跑过的命令）

旧代码获取（因为中途出现了提交，工作区已无未提交改动）：

```bash
cd /Users/supre/Documents/tmp/model-deploy-platform
git log --oneline -3          # HEAD=7d77463(新) HEAD~1=2c13be2(旧)
rm -rf /tmp/qa3-old && mkdir -p /tmp/qa3-old
git archive HEAD~1 | tar -x -C /tmp/qa3-old          # 旧实现
git archive HEAD backend/tests | tar -x -C /tmp/qa3-old   # 覆盖上新测试
cd /tmp/qa3-old/backend && <repo>/backend/.venv/bin/python -m pytest -q -rA --tb=no
# -> 111 FAILED, 86 PASSED；其中 test_planner_docker 30/32 FAILED，
#    test_qa_regressions::test_plan_window_never_exceeds_native_context FAILED，
#    test_qa_regressions::test_delete_removes_the_deployment FAILED
```

新代码基线：

```bash
cd backend && ./.venv/bin/python -m pytest -q     # 197 passed
cd desktop && node test-docker.js                  # 83 passed
cd desktop && node test-trust.js                   # 11 passed
cd desktop && node test-server.js                  # 76 passed
cd desktop && node test-install.js                 # 47 passed
cd desktop && node test-mlx.js                     # 15 passed
```

两侧 argv 对比 / 校验 fuzz：通过 `node <<'NODE'` require `desktop/deploy.js`，
`d.create({backend:"docker",...})` + `d._dockerArgv(item, 32768)`；
控制面用 `python - <<'PY'` 调 `planner.preview(PlanRequest(...))`、
`deployments.create(...)` 和 `TestClient(app)` POST `/api/plans/preview`、`/api/deployments`。
fuzz 用例覆盖：空格/分号/反引号/`$()`/管道/换行/NUL/201 字符/数字/对象/数组/相对路径/
不存在 host/9 volume/33 extra_arg/布尔 port 等。

信任边界：`node <<'NODE'` 起一个返回恶意 `command` 与 `decision.docker.image` 的
HTTP 服务，给 `Deployments` 指向它，并用记录 argv 的假 docker 观察真实 spawn。

Windows 纯函数：`node <<'NODE'` 直接 require `desktop/probe.js`，调用
`windowsGpuIsUma` / `classifyGpuVendor` / `parseWindowsRegistryGpus` / `parseNvidiaSmi`，
喂 30+ 个真实机型名。

E2E：`node <<'NODE'` 用 fetch 打 `http://127.0.0.1:50151` 走 create→start→health→delete。

---

## 处理结果（协调者回填）

本报告的所有发现**均已处理**。R3-12 不是缺陷，是对工作区的观察，已在下方说明。

| 编号 | 处理 | 具体改动 |
|---|---|---|
| R3-01 | ✅ 已修 | 决定**预览里不再出现 `--name`**。容器名是桌面端的生命周期键（`docker rm -f mdp-<部署 id>`），而部署 id 在预览时不存在；让控制面编一个 `mdp-<model_id>` 等于给出一个桌面端永远不用的名字。删掉了 `_docker_slug()` 整个函数和 `decision.docker.name` 字段，契约 §4 与 §4.1 写明这条差异。测试改为断言预览**没有** `--name`，桌面端断言名字取自部署 id |
| R3-02 | ✅ 已修 | `deploy.js` 的 `inferContainerPort` 与 `_dockerArgv` 改为先 `.toLowerCase()` 再匹配，与控制面 `image.lower()` 对齐。实测 `VLLM/VLLM-OPENAI:LATEST` 现在两侧都是 8000 + vllm 参数。新增 3 条测试 |
| R3-03 | ✅ 已修 | 去掉 `_normalize_docker_options` 里的 `.strip()`（它的 docstring 本来就写着「reject, never clean up」，代码和注释自相矛盾）。现在 `" vllm/x"` 在三条入口都 400；`None`/`""` 仍取默认镜像。新增测试 |
| R3-04 | ✅ 已修（补测试） | 新增一个**故意忽略 SIGTERM** 的子进程喂给 `_kill(child, 400)`，断言宽限期后被杀。实测 `alive_before=true dead_after=true elapsed_ms=404`。这条之前零覆盖 |
| R3-05 | ✅ 已修（补测试） | `test-trust.js` 新增 docker 用例：敌对控制面返回 `decision.docker.image:"evil/image:latest"` 与 `/etc:/etc` volume，断言桌面端用的是本地 UI 的镜像、没采纳服务给的 volume、`evil.sh` 未出现、标记文件未创建。11 → 15 项 |
| R3-06 | ✅ 已修 | 两条弱测试补上「先确认真的在 docker 路径上」的正向断言（`cmd[:3] == ["docker","run","--rm"]`、`"docker" not in cmd` 等），使其在旧代码下会失败 |
| R3-07 | ⚪ 有意保留 | 桌面端 `safePort` 的 8000 回退是**纵深防御**：UI 已在提交前用 `validPort` 拦截越界值（F-10），服务端 400 是第二道。保留回退可避免一个畸形值让整个创建请求失败。已在 `deploy.js` 注明 |
| R3-08 | ✅ 已修 | `test_core.py` / `test_client_hardware.py` 的窗口断言从 `1 <= window` 收紧为 `1 <= window <= entry.native_ctx` **且** 与 `estimator.plan_window(...)` 现算值相等 |
| R3-09 | ✅ 已修 | `windowsGpuIsUma` 补老 APU 规则：`/radeon\s+hd\s+\d{4}g\b/`（HD 8650G/7660G，尾缀 G 表示集显）与 `/radeon\s+r[2-9]\s+graphics\b/`（Kaveri 的 R7/R5 Graphics）。实测 14 个机型全部正确，包括**不能误判**的 `Radeon HD 7970`、`Radeon R7 240`、`Radeon R7 M260` |
| R3-10 | ✅ 已修 | `classifyGpuVendor` 的 intel 规则加 `\barc\s+[ab]\d{3}`，`Arc A770`（无 Intel 前缀）现在判为 intel。`Microsoft Basic Display Adapter` 仍为 unknown（正确） |
| R3-11 | ⚪ 保留 | 源码字符串断言是**契约 pin**（防止有人把 `StreamingResponse` 改回 `JSONResponse`），与同文件的行为测试互补。保留 |
| R3-12 | ⚪ 非缺陷 | 验证中途出现提交是协调者在并行提交，属正常流程；报告已正确改用 `HEAD~1` 取旧代码，处理得当 |

### 回归状态（处理后）

```
backend pytest -q -m "not network"   196 passed, 1 deselected
desktop  smoke / mlx 15 / trust 15 / install 47 / docker 89 / server 76
electron frontend 37 / backend-ui 10+21 / layout 6
```

`desktop/test-docker.js` 83 → 89（+R3-01/02/04），`test-trust.js` 11 → 15（+R3-05）。

### 一点说明

R3-01 我选择的是「让预览不写 `--name`」，而不是「让桌面端改用 slug 名字」。
原因是桌面端**必须**用部署 id 才能可靠 `docker rm -f` 自己启动的容器
（同一个模型可能有多个部署），而控制面在预览时拿不到部署 id。
两边都不可能生成同一个名字，所以正确的做法是把这条差异写进契约，
而不是维持一个「看起来一致、实际永远对不上」的字段。

