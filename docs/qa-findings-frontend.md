# QA 报告 · 前端与端到端（frontend/index.html）

- 仓库：/Users/supre/Documents/tmp/model-deploy-platform
- 分支：feat/client-hardware-profile（未切换、未合并、未 push）
- 被检提交：2274e79 "feat(ui): 单页重构，去掉侧边栏，项目名移到 Electron 标题栏"
- 被检文件：frontend/index.html（518 行 / 30013 字节）
- 测试日期：2026-09-23
- 测试手段：
  - 静态提取与交叉比对（getElementById / HTML id / onclick / 函数定义）
  - 隔离控制面实例 http://127.0.0.1:8799（backend/.venv + uvicorn，内存态部署，不污染 8790）
  - 真实 Chromium（Google Chrome headless + DevTools Protocol）加载页面，读取真实 DOM / 运行时行为
  - 运行中的共享控制面 http://127.0.0.1:8790 与 Electron 控制面 http://127.0.0.1:62847 做只读比对
  - Ollama 11434 真实模型 qwen3:8b（用完即卸载，同一时间只加载一个模型）
- 重要说明：本报告只记录问题，未修改任何源码；所有写入都在 /tmp 与 docs/qa-findings-frontend.md。

## 结论概览

**单页重构本身没有把外壳改坏**：不存在「id 找不到」「函数没定义」「show()/renderBanner/wizard 残留」这类断链，4 个 <details> 内容都能渲染，jump('profile') 能正确展开。重构是安全的。

但在精读 + 真实浏览器复现中发现了 **13 个确认问题**（另有 2 条代码审查怀疑）。其中最严重的一条是**部署模型下拉的 option.value 被双引号截断**，导致「选择模型 / 部署这个模型 / 模型路径联动」这条核心链路整体失效——它早于本次重构（git blame 指向 ffdf998），不是这次改外壳引入的，但确实存在。

严重程度分布：阻断 0 · 严重 1 · 一般 7 · 轻微 5 · 存疑（怀疑）2。

---

## 一、单页重构回归检查（结论：通过）

用脚本把 script 块里的 \`getElementById('...')\` 与 HTML 里的 \`id="..."\` 做双向差集，并提取所有 \`onclick/onchange\` 里的函数名与 \`function\` 定义做差集：

- HTML id：47 个；JS getElementById：44 个。
- **JS 引用但 HTML 不存在：0 个**（不存在「某个 id 找不到了」）。
- HTML 有但 JS 从不直接引用：\`deploy\`、\`service\`、\`profile\` 三个，其中 \`profile\`/\`deploy\` 由 \`jump('...')\` 动态引用，\`service\` 是死 id（见问题 12）。
- 动态拼接 id：只有 \`getElementById(id)\`（jump 的参数），无 \`'pf-'+suffix\` 之类的字符串拼接。
- handler 里调用的函数：applyProfileForm / copyAdvisory / copyCode / copyProbe / createDeploy / depLogs / depStart / depStop / healthCheck / jump / parseCode / quickRam / refresh / runBrowserProbe / runTest / syncDeploy / usePick —— **全部有定义，0 个未定义**。
- 全文 grep \`\bshow(\` / \`renderBanner\` / \`wizard\` / \`getElementById('banner')\`：**0 处残留**。
- 真实 Chrome 验证：\`jump('profile')\` 后 \`#profile.open === true\`；4 个 details 全部可渲染（budget-log / rows / pf-out / checks / raw-env 五个内容节点都有真实数据）。

> 复现（静态比对，可复制执行）：
> \`\`\`bash
> python3 - <<'PY'
> import re
> t=open('/Users/supre/Documents/tmp/model-deploy-platform/frontend/index.html').read()
> html=set(re.findall(r'\bid\s*=\s*["\']([^"\']+)["\']', t))
> js=set(re.findall(r'getElementById\(\s*[\'"]([^\'"]+)[\'"]\s*\)', t))
> defs=set(re.findall(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', t))
> calls=set()
> for h in re.findall(r'\bon(?:click|change)\s*=\s*["\']([^"\']*)["\']', t):
>     calls|=set(re.findall(r'([A-Za-z_$][\w$]*)\s*\(', h))
> print('JS refs missing in HTML:', sorted(js-html))
> print('handler calls undefined :', sorted(calls-defs))
> print('residual show/renderBanner/wizard:', [w for w in ('show(','renderBanner','wizard') if w in t])
> PY
> \`\`\`

---

## 二、确认的 bug

### 1. 【严重】部署模型下拉 option.value 被双引号截断，模型选择/推荐联动/「部署这个模型」全部失效

- 严重程度：严重
- 位置：frontend/index.html:401（根因 esc 在 :183；受影响：currentModel :405、syncDeploy :406、usePick :442、createDeploy :478）
- 复现（无需浏览器，直接执行）：

\`\`\`bash
# 用运行中的实例取真实推荐，按前端模板拼 option，再用 HTML 解析器读 value
curl -s http://127.0.0.1:8799/api/models/recommend -H 'content-type: application/json' \
  -d '{"task":"chat","goal":"balanced","backend":"ollama","limit":40,"hardware":{"source":"manual","platform":"darwin","architecture":"arm64","cpu_cores":10,"ram_gb":24,"gpus":[{"name":"Apple M5","vendor":"unknown","vram_gb":null,"uma":true}]}}' \
  | python3 -c '
import sys,json,html.parser
d=json.load(sys.stdin)
def esc(s): return str("" if s is None else s).replace("&","&amp;").replace("<","&lt;")
for r in [x for x in d["recommendations"] if x["fits"]][:1]:
    src=r.get("source") or {}
    obj={"id":r["id"],"name":r["name"],"ollama":src.get("ollama") or "","path":src.get("huggingface") or r["id"]}
    opt="<option value=\""+esc(json.dumps(obj,ensure_ascii=False,separators=(",",":")))+"\">"+esc(r["name"])+"</option>"
    print("generated:", opt[:120])
    class P(html.parser.HTMLParser):
        def handle_starttag(self,tag,attrs):
            if tag=="option": print("parsed value attr ->", repr(dict(attrs).get("value")))
    P().feed("<select>"+opt+"</select>")
'
\`\`\`

- 期望：\`option.value\` 是完整的 JSON 字符串（\`{"id":"qwen3-8b",...}\`），\`currentModel()\` 能 \`JSON.parse\` 出对象，选择模型后 d-path/d-name 自动同步，usePick 能选中推荐模型。
- 实际（真实 Chrome + CDP 读取真实 DOM）：

\`\`\`text
A. d-model option/currentModel: {"optionCount":2,"firstOptionValue":"{",
   "parseError":"SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)",
   "dPath":"qwen3:8b","dName":"qwen3:8b","rec":false}
\`\`\`

真实 Chrome 的 dump-dom 里，option 已经被解析成：
\`\`\`html
<option value="{" id":"qwen2.5-vl-7b-cuda","name":"qwen2.5-vl="" 7b="" ·="" awq="" gptq", ...>
\`\`\`
即 \`value\` 属性在第一个 \`"\` 处结束，值为 \`{\`，后面的 JSON 被当成一堆垃圾属性。

连带的真实行为（同一 CDP 会话）：
\`\`\`text
E. usePick-style matching: {"matchedIndex":-1}
A. rec + usePick (settled): {"recId":"qwen3-8b","pickText":"Qwen3 8B · GGUF ...",
   "before":{"path":"qwen3:8b","idx":0,"opt0":"{","optCount":20},
   "after":{"path":"qwen3:8b","idx":0}}   // 调用了 usePick()，selectedIndex 仍是 0，d-path 没变
\`\`\`

- 影响：
  1. \`syncDeploy()\` 第一行 \`var m=currentModel(); if(!m) return;\` 永远早退，**在「部署」下拉里切换模型不会更新「模型路径 / Ollama 标签」和「模型名」**，页面显示选的是 A，实际创建的是 d-path 里残留的默认值（默认 qwen3:8b）。默认值恰好等于推荐模型时看起来"能跑"，换个模型立刻暴露。
  2. \`usePick()\`（「部署这个模型」按钮）遍历 option、\`JSON.parse(option.value)\` 全部抛异常被 catch 吞掉，**永远选不中任何模型**，只是滚动到部署区。
  3. \`createDeploy()\` 里 \`model_id\` 永远是 \`'custom'\`。
- 备注：这是**重构前就存在**的问题。\`git blame\` 显示 :401 来自 ffdf9982，:183 esc 来自 08b498be；\`git show 2274e79^:frontend/index.html\` 里 fillDeployModels 的该行与当前**逐字相同**。本次单页重构没有引入它，但也没有修。

---

### 2. 【一般】esc() 不转义引号，部署 model_path 可注入 HTML 属性（DOM 注入）

- 严重程度：一般（属性注入已确认；handler 是否被用户操作触发未确认）
- 位置：frontend/index.html:183（esc）、:465（t-dep option 拼接）
- 根因：\`esc(s)\` 只替换 \`&\` 和 \`<\`，**不处理 \`"\`、\`'\`、\`>\`**。当它被用于**属性上下文**时即可闭合属性。
- 复现：

\`\`\`bash
# 1) 造一个 model_path 带引号的部署（后端会原样保存）
curl -s -X POST http://127.0.0.1:8799/api/deployments -H 'content-type: application/json' \
  -d '{"model_path":"evil\" onmouseover=\"alert(1)","model_id":"x","backend":"llama.cpp","port":8080}'
# 2) 浏览器打开页面后，在 DevTools Console 执行：
#    document.getElementById('t-dep').innerHTML
\`\`\`

- 期望：model_path 作为属性值被完整转义（\`"\` → \`&quot;\`），不会产生新属性。
- 实际（真实 Chrome DOM，onmouseover 确实被解析成独立属性）：

\`\`\`html
<option value="dep_1790098680" data-model="evil" onmouseover="alert(1)">dep_1790098680 · evil" onmouseover="alert(1) · CREATED</option>
\`\`\`
Python html.parser 与 Chrome 均确认解析出属性 \`('onmouseover','alert(1)')\`。

- 影响：控制面是**无鉴权**的，\`POST /api/deployments\` 对「本机/本机 LAN IP」客户端开放；任何能创建部署的人写入带引号的 model_path 后，**其他打开该页面的人**会加载到一个被注入属性的 option。由于 \`<\` 被转义，无法插入新标签，注入面被限制在 option 的属性上；原生 select 下拉里 option 的鼠标事件是否真的会触发 handler 我**没有确认**（见「怀疑 S2」）。同一根因也是问题 1 的成因。

---

### 3. 【一般】后端不可用时 refresh() 不更新状态行，页面永久停在「正在检测…」

- 严重程度：一般
- 位置：frontend/index.html:315-351（refresh），:352-363（renderStatus）
- 复现（浏览器打开页面后，DevTools Console）：

\`\`\`js
(async()=>{ var of=window.fetch; window.fetch=()=>Promise.reject(new Error('down'));
  document.getElementById('status-text').textContent='正在检测…';
  document.getElementById('status-dot').className='dot';
  await refresh(); window.fetch=of;
  console.log(document.getElementById('status-text').textContent,
              document.getElementById('status-dot').className,
              document.getElementById('pick').textContent); })()
\`\`\`

- 期望：请求失败时状态行应变为「无法连接后端」之类，硬件卡片应清空或标注未知，而不是停在初始文案。
- 实际：

\`\`\`text
D. refresh with backend down: {"statusText":"正在检测…","dot":"dot",
   "pick":"后端未启动","rows":"后端未启动",
   "checks":"[PASS] GPU 检测到 Apple Silicon GPU，可使用统一内存"}
\`\`\`

\`status-text\` 仍是「正在检测…」，\`status-dot\` 仍是灰点；只有 pick/rows 变成了「后端未启动」。硬件卡片 \`hw-device/hw-budget/...\` 保留上一次的旧值（首次加载则一直是「—」）。
- 影响：后端没起来时，用户看到顶部永远转圈「正在检测…」，会以为页面卡死；且硬件卡片残留旧数据可能误导。

---

### 4. 【一般】healthCheck() 无 try/catch 且不检查响应码：网络失败产生 unhandled rejection，500 时 UI 停在旧内容

- 严重程度：一般
- 位置：frontend/index.html:504-508
- 复现（DevTools Console，先把 t-dep 指向一个不存在的 id）：

\`\`\`js
// (a) 500 非 JSON 响应：/api/deployments/nope/health 返回 500 text/plain "Internal Server Error"
var sel=document.getElementById('t-dep'); sel.innerHTML='<option value="nope">nope</option>'; sel.selectedIndex=0;
healthCheck();                       // 不 await，模拟 onclick
// (b) 网络失败：
window.onunhandledrejection=e=>console.log('UR',String(e.reason));
window.fetch=()=>Promise.reject(new Error('netdown')); healthCheck();
\`\`\`

- 期望：\`healthCheck\` 捕获异常、检查 \`r.ok\`，并在 \`#t-out\` 明确显示「健康检查失败」。
- 实际：

\`\`\`text
1. missing-deploy health HTTP: {"status":500,"ct":"text/plain; charset=utf-8","body":"Internal Server Error"}
B. healthCheck rejection: {"onUR":["onUR:Error: netdown"],"addEv":["addEv:Error: netdown"]}
\`\`\`

网络失败时确实抛出 **unhandled promise rejection**（onclick 调用形式）；500 时 \`.json()\` 抛错，\`#t-out\` 保持在旧内容（实测仍为「尚未测试」），用户点击「健康检查」没有任何反馈。
- 影响：控制面掉线时页面产生未处理的 Promise 拒绝；对已删除/失效的部署点「健康检查」时 UI 无任何提示，看起来像按钮失灵。

---

### 5. 【一般】depStart()/depStop() 无错误处理，网络失败产生 unhandled rejection

- 严重程度：一般
- 位置：frontend/index.html:476-477
- 复现（DevTools Console）：

\`\`\`js
window.onunhandledrejection=e=>console.log('UR',String(e.reason));
window.fetch=()=>Promise.reject(new Error('netdown'));
depStart('x'); depStop('x');   // 不 await，模拟 onclick
\`\`\`

- 期望：失败时在 \`#d-log\` 或列表处提示，而不是静默抛异常。
- 实际：\`{"unhandled":["Error: netdown","Error: netdown"]}\`
- 影响：后端不可用时点「启动 / 停止」无任何反馈并产生未处理拒绝；状态也不会刷新（refreshDeployments 会因同样 fetch 失败而静默走 catch）。

---

### 6. 【一般】部署列表轮询会重置用户在「服务测试」里选中的实例，并改写模型名

- 严重程度：一般
- 位置：frontend/index.html:449-467（refreshDeployments，:465 重建 t-dep）、:468-474（onTestDepChange）
- 复现（DevTools Console，用桩数据模拟一次轮询）：

\`\`\`js
(async()=>{ var of=window.fetch;
  window.fetch=(u,o)=> (String(u).indexOf('/api/deployments')===0 && (!o||o.method!=='POST'))
    ? Promise.resolve({ok:true,json:()=>Promise.resolve({deployments:[
        {id:'dep_1',model_path:'m1',backend:'llama.cpp',status:'STARTING',endpoint:'e1',log:[]},
        {id:'dep_2',model_path:'m2',backend:'llama.cpp',status:'STOPPED',endpoint:'e2',log:[]}]})})
    : of(u,o);
  await refreshDeployments();
  var sel=document.getElementById('t-dep'); sel.selectedIndex=1; sel.dispatchEvent(new Event('change'));
  console.log('picked', sel.value, 't-model', document.getElementById('t-model').value);
  await refreshDeployments();   // 3 秒轮询
  console.log('after poll idx', sel.selectedIndex, 'value', sel.value, 't-model', document.getElementById('t-model').value);
  window.fetch=of; })()
\`\`\`

- 期望：轮询刷新列表时保留当前选中的部署实例。
- 实际：

\`\`\`text
B. poll resets t-dep selection: {"picked":"dep_2","modelAfterPick":"m1",
   "indexAfterPoll":0,"valueAfterPoll":"dep_1","pollScheduled":true}
\`\`\`

- 影响：只要有部署处于 STARTING（每 3s 轮询一次），用户刚选好的实例就会被重置为列表第一个，\`t-model\` 也被改写，正在输入/准备发送的测试会打到错误的部署上。

---

### 7. 【一般】部署下拉包含当前后端不支持的模型

- 严重程度：一般
- 位置：frontend/index.html:398（\`filter(function(r){return r.fits;})\`）
- 复现：

\`\`\`bash
# 推荐结果里 qwen2.5-vl-7b-cuda 的 reason 是「当前后端不支持该模型」，但 fits=true
curl -s http://127.0.0.1:8799/api/models/recommend -H 'content-type: application/json' \
 -d '{"task":"chat","goal":"balanced","backend":"ollama","limit":5,"hardware":{"source":"browser","platform":"darwin","ram_gb":null,"gpus":[]}}' \
 | python3 -c "import sys,json;d=json.load(sys.stdin);[print(r['id'],r['fits'],r['reason']) for r in d['recommendations']]"
# 浏览器 DevTools Console：
#   [...document.getElementById('d-model').options].map(o=>o.textContent)
\`\`\`

- 期望：部署下拉只列当前后端（\`#backend\` / \`#d-backend\`）可运行的模型；不支持的模型不应出现在可部署列表里（或在 label 上标注不可用）。
- 实际：Chrome 渲染出的 d-model 前两项就是 \`Qwen2.5-VL 7B · AWQ/GPTQ · n/a\` 与 \`Phi-4-mini · AWQ/GPTQ · n/a\`，它们的 reason 都是「当前后端不支持该模型」。
- 影响：用户在下拉里选到后端不支持的模型，创建后必然启动失败，浪费一次部署/加载。

---

### 8. 【一般 · 跨层】部署 id 用秒级时间戳，同一秒创建两个部署会互相覆盖

- 严重程度：一般（后端问题，但直接表现为前端列表丢条目）
- 位置：backend/app/services/deployments.py:46（\`dep_id = f"dep_{int(time.time())}"\`）
- 复现：

\`\`\`bash
python3 - <<'PY'
import json,urllib.request
B='http://127.0.0.1:8799'
def post(p,b):
    r=urllib.request.Request(B+p,data=json.dumps(b).encode(),headers={'content-type':'application/json'})
    return json.loads(urllib.request.urlopen(r).read())
ids=[post('/api/deployments',{'model_path':'m%d'%i,'model_id':'m%d'%i,'backend':'llama.cpp','port':8080+i})['id'] for i in range(2)]
print('ids:',ids,'unique:',len(set(ids)))
PY
\`\`\`

- 期望：id 全局唯一（或至少带自增序号）。
- 实际：\`created ids: ['dep_1790099048', 'dep_1790099048'] -> unique: 1\`，第二次创建覆盖第一次，列表里只剩一条。
- 影响：前端「创建并启动」按钮在创建期间**没有 disabled**（createDeploy 里没有置灰），用户快速双击/连点会生成两个请求，同秒内第二个覆盖第一个，表现为「部署莫名消失/只创建了一个」。注意 Electron 端 server.js 的 id 带序号（\`dep_..._1\`），不受影响。

---

### 9. 【轻微】后端下拉硬编码 5 个后端，未使用 /api/backends 返回的 CONFIG.backends

- 严重程度：轻微
- 位置：frontend/index.html:82-85（#backend）、:105-107（#d-backend）、:511（\`CONFIG=await fetch('/api/backends')\`）
- 复现：

\`\`\`bash
curl -s http://127.0.0.1:8799/api/backends      # {"backends":["ollama"],"allow_remote_deploy":false}
curl -s http://127.0.0.1:8790/api/backends      # {"backends":["ollama"],"allow_remote_deploy":false}
# 但页面两个下拉都写死了 ollama/llama.cpp/transformers/vllm/sglang
grep -n 'option value="vllm"' /Users/supre/Documents/tmp/model-deploy-platform/frontend/index.html
\`\`\`

- 期望：下拉只提供实际可用的后端（或把不可用的置灰/标注），\`CONFIG.backends\` 至少被用来做提示。
- 实际：\`CONFIG\` 只用了 \`allow_remote_deploy\`，\`backends\` 从未被读取；用户可选 transformers/vllm/sglang，但 /api/backends 明确只支持 ollama，选了会得到无推荐或 BLOCKED。
- 影响：误导用户选择本机不具备的后端。

---

### 10. 【轻微】d-port / t-max 缺 min/max 与 JS 校验（空值变 0，非数字变 NaN）

- 严重程度：轻微
- 位置：frontend/index.html:108（d-port）、:127（t-max）；使用处 :482、:499
- 复现（DevTools Console）：

\`\`\`js
var p=document.getElementById('d-port'), m=document.getElementById('t-max');
console.log(p.hasAttribute('min'), p.hasAttribute('max'), m.hasAttribute('min'), m.hasAttribute('max'));
console.log(+'' , +'abc');   // 0, NaN
\`\`\`

- 期望：端口限定 1-65535、max_tokens 限定正整数；非法输入在提交前被拦截或归一化。
- 实际：\`{"portHasMin":false,"portHasMax":false,"tmaxHasMin":false,"tmaxHasMax":false,"portEmptyToNum":0,"tmaxAbcToNum":null}\`（NaN 经 CDP 序列化为 null）。\`createDeploy\` 用 \`+value\`、\`runTest\` 用 \`+value\` 直接下发。
- 影响：清空端口 → 0，清空 max_tokens → 0，非数字 → NaN（\`JSON.stringify\` 后变 null），后端返回 422，前端只显示一串数组形式的 \`detail\`；体验差但不会崩。对比：pf-cores/pf-ram/pf-vram 是有 min/max 的。

---

### 11. 【轻微】18 个 <label> 全部没有 for，未与任何控件关联

- 严重程度：轻微
- 位置：frontend/index.html 全文（如 :104-110、:124-127、:145-153）
- 复现（DevTools Console）：

\`\`\`js
console.log(document.querySelectorAll('label').length, document.querySelectorAll('label[for]').length,
            document.querySelectorAll('form').length);
\`\`\`

- 期望：\`<label for="d-model">模型</label>\` 与对应 input 的 id 关联，点击 label 聚焦控件，屏幕阅读器可读。
- 实际：\`{"labels":18,"labelsWithFor":0,"forms":0}\`。控件本身都有 id，只差 \`for\`。
- 影响：无障碍/可点击区域退化；纯 a11y 问题。另外 \`pf-presets\` 的 label 包着一个 div（不是表单控件），也未被关联。

---

### 12. 【轻微】id="service" 是死 id，从未被 jump 使用

- 严重程度：轻微
- 位置：frontend/index.html:117（\`<section class="card" id="service">\`）
- 复现：

\`\`\`bash
grep -n "jump('" /Users/supre/Documents/tmp/model-deploy-platform/frontend/index.html
# 只有 jump('profile')（renderStatus）和 jump('deploy')（usePick）
\`\`\`

- 期望：要么有跳转到服务测试的入口（如部署成功后跳过去），要么去掉该 id。
- 实际：\`service\` 从未被任何 jump/引用；\`deploy\` 由 usePick 使用，\`profile\` 由状态行链接使用。
- 影响：无功能影响，只是重构遗留的无效锚点（说明导航语义没完全补齐）。

---

### 13. 【轻微】resolveProfile() 不 await refresh()，归一化结果与主卡片更新存在竞态

- 严重程度：轻微
- 位置：frontend/index.html:256-268
- 复现（DevTools Console）：

\`\`\`js
(async()=>{ PROFILE={source:'manual',platform:'darwin',architecture:'arm64',cpu_cores:10,ram_gb:24,
    gpus:[{name:'Apple M5',vendor:'unknown',vram_gb:null,uma:true}]};
  await resolveProfile();
  console.log('right after await, LAST=', window.LAST);          // 仍是旧值 / null
  await new Promise(r=>setTimeout(r,3000));
  console.log('after settle, LAST=', window.LAST && window.LAST.recommendation); })()
\`\`\`

- 期望：\`resolveProfile\` 内 \`await refresh()\`，或让调用方知道主卡片何时更新完。
- 实际：\`resolveProfile\` 里最后一行是裸的 \`refresh();\`（未 await），\`pf-out\` 已更新但 \`LAST\`/主卡片要晚一拍。我在测试中 \`await resolveProfile()\` 后立即读 \`LAST.recommendation\` 得到 null，3.5s 后才变成 qwen3-8b。
- 影响：短暂不一致（点「应用并重新推荐」后主卡片慢一拍），通常几百毫秒内自愈；无持久错误。

---

## 三、代码审查怀疑（未复现为可执行攻击）

### S1. onclick 里拼接的部署 id 未转义（当前 id 格式安全，契约脆弱）
- 位置：frontend/index.html:459 \`onclick="depStart('\\''+d.id+'\\')"\`（depStop/depLogs 同）
- 说明：表格单元格里 \`esc(d.id)\` 是转义的，但 onclick 内联属性里的 \`d.id\` 是**裸拼**。当前 Python 后端 id 形如 \`dep_1790098653\`、Electron 端形如 \`dep_1790096051651_1\`，都不含引号，因此**当前不可利用**。但一旦 id 生成规则变化或数据来自别处，就会变成 DOM XSS。建议统一走 \`esc\` 或改事件委托。

### S2. 问题 2 注入的 onmouseover 是否真能被用户触发，未确认
- 说明：我已确认 model_path 里的 \`"\` 能闭合 \`data-model\` 属性并让浏览器生成独立的 \`onmouseover\` 属性（Python html.parser 与真实 Chrome 都确认）。但原生 \`<select>\` 的下拉项在 macOS 上是系统绘制的，option 的 mouse 事件是否派发**我没有验证**；用 JS 手工 \`dispatchEvent\` 不算真实用户触发。因此「属性注入」是确认的，「可被用户操作触发的 XSS」是存疑的。若要在报告里定级，应按「确认的转义缺陷 + 存疑的可利用性」理解。

---

## 四、验证通过（未发现问题的项，供回归参考）

1. **思考模型渲染（本轮重点）**：后端 \`test_chat\` 对 qwen3:8b + \`max_tokens=64\` 返回 \`reply_source="reasoning"\`、\`finish_reason="length"\`、\`hint="回复被 max tokens 截断…"\`。前端 \`runTest\` 正确渲染了 \` · 来自思考内容\` 标记与 hint，且都走 \`esc()\`。默认 \`max_tokens=512\`（HTML 与后端默认一致）生效。实测（CDP 桩数据）：\`{"xss":0,"imgs":0,"html":"...<span class=\\"warn\\"> · 来自思考内容</span>...&lt;img ...&gt;..."}\`。
2. **runTest / renderRows 的转义**：把 reply/hint/模型名/原因构造成 \`<img src=x onerror=...>\`，\`#t-out\` 与 \`#rows\` 内 \`querySelectorAll('img').length === 0\`、\`window.__xss === 0\`，全部以文本呈现。
3. **折叠面板渲染**：真实 Chrome dump-dom 中 \`#budget-log\`、\`#rows\`、\`#pf-out\`、\`#checks\`、\`#raw-env\` 五个内容节点都有真实数据；\`jump('profile')\` 后 \`#profile.open === true\`。
4. **响应式布局**：CDP \`Emulation.setDeviceMetricsOverride\` 在 720/520/400px 下 \`documentElement.scrollWidth === clientWidth\`（无横向溢出），没有任何按钮 right 超出视口；\`.hw\`/\`.form\` 在 720 为 2 列、≤520 为 1 列。Electron minWidth=720，媒体查询 760/520 覆盖到位。
5. **无 form、按钮不会误提交**：全文 0 个 \`<form>\`；按钮虽无 \`type\`，但不在表单里，无副作用。
6. **空态**：无部署时 \`#d-list\` 显示「暂无部署」、\`#t-dep\` 为空时 \`runTest\` 提示「请先创建部署」；浏览器读不到内存时 \`#pick\` 显示「还差一个内存档位」+ 档位按钮；无推荐时显示「无自动推荐」+ reason。
7. **端到端主链路（隔离实例 8799）**：create → start → health → test → stop 全部 200；\`start\` 2.1s 把 qwen3:8b 常驻，\`test(512)\` 13.6s 返回正常中文回复，\`stop\` 成功卸载（\`ollama ps\` 为空）。
8. **桌面 smoke**：\`node smoke.js\` 全部 PASS（未加载真模型），包含「serves existing frontend」的语义断言。

---

## 五、汇总表（按严重程度排序）

| # | 标题 | 严重程度 | 位置 | 类型 |
|---|------|----------|------|------|
| 1 | 部署下拉 option.value 被引号截断，模型选择/推荐联动/usePick 全失效 | 严重 | frontend/index.html:401 | 确认 |
| 2 | esc() 不转义引号，model_path 可注入 HTML 属性 | 一般 | frontend/index.html:183,465 | 确认 |
| 3 | 后端不可用时状态行停在「正在检测…」 | 一般 | frontend/index.html:315-363 | 确认 |
| 4 | healthCheck 无异常/响应码处理，网络失败 unhandled rejection、500 无反馈 | 一般 | frontend/index.html:504-508 | 确认 |
| 5 | depStart/depStop 无异常处理，网络失败 unhandled rejection | 一般 | frontend/index.html:476-477 | 确认 |
| 6 | 部署轮询重置 t-dep 选择并改写 t-model | 一般 | frontend/index.html:449-474 | 确认 |
| 7 | 部署下拉包含当前后端不支持的模型 | 一般 | frontend/index.html:398 | 确认 |
| 8 | 部署 id 秒级时间戳，同秒创建互相覆盖（跨层） | 一般 | backend/app/services/deployments.py:46 | 确认 |
| 9 | 后端下拉硬编码，未用 /api/backends | 轻微 | frontend/index.html:82-85,105-107,511 | 确认 |
| 10 | d-port / t-max 缺 min/max 与校验 | 轻微 | frontend/index.html:108,127 | 确认 |
| 11 | 18 个 label 全部缺 for | 轻微 | frontend/index.html 全文 | 确认 |
| 12 | id="service" 死 id | 轻微 | frontend/index.html:117 | 确认 |
| 13 | resolveProfile 不 await refresh 的竞态 | 轻微 | frontend/index.html:256-268 | 确认 |
| S1 | onclick 拼接部署 id 未转义（当前格式安全） | 存疑 | frontend/index.html:459 | 怀疑 |
| S2 | 注入的 onmouseover 能否被真实用户触发 | 存疑 | frontend/index.html:465 | 怀疑 |

---

## 六、给修复者的最短建议（不涉及本次改动，仅供参考）

1. 把 \`esc()\` 升级为完整实体转义（至少 \`&\`、\`<\`、\`>\`、\`"\`、\`'\`），或对属性值单独用 \`encodeURIComponent\`/\`JSON.stringify\` 后再塞进 \`value\`。这一条同时修掉问题 1 和问题 2。
2. \`refresh()\` 的 \`else\` 分支里同时重置 \`status-dot/status-text\` 与硬件卡片；\`healthCheck/depStart/depStop\` 加 \`try/catch\` 与 \`r.ok\` 检查。
3. \`refreshDeployments\` 重建 t-dep 前记住当前 value，重建后恢复；或只在列表变化时重建。
4. 部署下拉的过滤条件加入后端兼容性（如 \`r.reason_key!=='backend-incompatible'\`）。
5. \`createDeploy\` 期间禁用 \`#deploy-btn\`；后端 id 加自增序号。
