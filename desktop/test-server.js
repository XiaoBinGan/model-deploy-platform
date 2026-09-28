"use strict";

// Pure-node tests for the desktop server/proxy layer (no Electron, no control
// plane). Run: cd desktop && node test-server.js
//
// The desktop server reads MDP_SERVICE and MDP_UPSTREAM_TIMEOUT_MS at require
// time, so both are set before ./server is loaded. The upstream stub is the
// "control plane": it records what the proxy forwarded and can hang on demand.

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
  if (ok) pass += 1;
  else fail += 1;
}

function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url.indexOf("/api/hang") === 0) return; // never answer
      if (req.url.indexOf("/api/echo") === 0) {
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "max-age=60",
          "x-upstream": "yes",
        });
        return res.end(JSON.stringify({ headers: req.headers, body }));
      }
      if (req.url.indexOf("/api/boom") === 0) {
        res.writeHead(503, { "content-type": "text/plain" });
        return res.end("upstream down");
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "upstream not found" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });
}

// Raw request so the exact request line (including "..") reaches the server;
// fetch would normalize it away before sending.
// 写操作要带 token（DESK-29）。
let TOKEN = "";
function withToken(url) {
  return url + (url.indexOf("?") < 0 ? "?" : "&") + "token=" + encodeURIComponent(TOKEN);
}

function rawRequest(port, rawPath, method) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: rawPath, method: method || "GET" },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", () => resolve(0));
    req.end();
  });
}

(async () => {
  const upstream = await startUpstream();
  process.env.MDP_SERVICE = "http://127.0.0.1:" + upstream.port;
  process.env.MDP_UPSTREAM_TIMEOUT_MS = "700";

  const { start } = require("./server");
  const {
    gb,
    normalizeGpuName,
    classifyGpuVendor,
    windowsGpuIsUma,
    parseNvidiaSmi,
    parseWindowsRegistryGpus,
    parseVmStatValue,
    sumVmStatPages,
    choosePageSize,
  } = require("./probe");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-server-test-"));
  // Pre-seed a row that will be dropped on load (DESK-26), so the API outlet for
  // `rejected` is exercised rather than asserted from an always-empty array.
  fs.writeFileSync(path.join(dataDir, "deployments.json"), JSON.stringify({
    seq: 1,
    items: [{ id: "dep_bad", backend: "ollama", model_path: "--help", status: "STOPPED", log: [] }],
  }));
  const s = await start(0, { dataDir });
  const base = s.url;
  // 写操作要带 token（DESK-29）。像浏览器那样从服务端渲染的页面里取，
  // 顺便也验证了注入确实发生。
  const html0 = await (await fetch(base)).text();
  const tmatch = /API_TOKEN='([^']*)'/.exec(html0);
  TOKEN = tmatch ? tmatch[1] : "";
  console.log("desktop server:", base, "| upstream:", process.env.MDP_SERVICE);

  // --- DESK-25: readBody size cap -----------------------------------------
  const big = "x".repeat(2 * 1024 * 1024);
  const rBig = await fetch(base + "api/plans/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pad: big }),
  });
  check("readBody rejects a >1MiB body with 413", rBig.status === 413, "status=" + rBig.status);

  // --- DESK-11: non-object JSON body is a 400, not a 500 -------------------
  for (const payload of ["null", "123", "\"hello\"", "[]"]) {
    const r = await fetch(base + "api/plans/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    check("non-object body " + payload + " -> 400", r.status === 400, "status=" + r.status);
  }
  const rBadJson = await fetch(base + "api/models/recommend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  check("malformed JSON -> 400", rBadJson.status === 400, "status=" + rBadJson.status);
  const rRecArr = await fetch(base + "api/models/recommend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "[]",
  });
  check("models/recommend array body -> 400", rRecArr.status === 400, "status=" + rRecArr.status);

  // --- DESK-15: missing deployment is 404 ----------------------------------
  const rGetMissing = await fetch(base + "api/deployments/dep_nope");
  check("GET missing deployment -> 404", rGetMissing.status === 404, "status=" + rGetMissing.status);
  const rStartMissing = await fetch(base + "api/deployments/dep_nope/start", { method: "POST" });
  check("POST missing start -> 404", rStartMissing.status === 404, "status=" + rStartMissing.status);
  const rStopMissing = await fetch(base + "api/deployments/dep_nope/stop", { method: "POST" });
  check("POST missing stop -> 404", rStopMissing.status === 404, "status=" + rStopMissing.status);
  const rHealthMissing = await fetch(base + "api/deployments/dep_nope/health");
  check("GET missing health -> 404", rHealthMissing.status === 404, "status=" + rHealthMissing.status);
  const rTestMissing = await fetch(base + "api/deployments/dep_nope/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check("POST missing test -> 404", rTestMissing.status === 404, "status=" + rTestMissing.status);
  const rDelMissing = await fetch(base + "api/deployments/dep_nope", { method: "DELETE" });
  check("DELETE missing deployment -> 404", rDelMissing.status === 404, "status=" + rDelMissing.status);

  // --- DESK-19: local routes validate the method ---------------------------
  const mHealth = await fetch(base + "api/health", { method: "POST" });
  check("POST /api/health -> 405", mHealth.status === 405, "status=" + mHealth.status);
  check("405 carries an Allow header", mHealth.headers.get("allow") === "GET",
    "allow=" + mHealth.headers.get("allow"));
  const mSelf = await fetch(base + "api/hardware/self", { method: "PUT" });
  check("PUT /api/hardware/self -> 405", mSelf.status === 405, "status=" + mSelf.status);
  const mBackends = await fetch(base + "api/backends", { method: "POST" });
  check("POST /api/backends -> 405", mBackends.status === 405, "status=" + mBackends.status);
  const mDeploys = await fetch(base + "api/deployments", { method: "PUT" });
  check("PUT /api/deployments -> 405", mDeploys.status === 405, "status=" + mDeploys.status);

  // An existing deployment is needed to check method checks on its actions.
  const created = await (await fetch(withToken(base + "api/deployments"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend: "ollama", model_name: "test-model", model_id: "test-model" }),
  })).json();
  const depId = created && created.id;
  check("created a deployment for route checks", !!depId, String(depId));
  if (depId) {
    const existing = await fetch(base + "api/deployments/" + depId);
    check("GET existing deployment -> 200", existing.status === 200, "status=" + existing.status);
    const mAction = await fetch(base + "api/deployments/" + depId + "/start");
    check("GET on a POST-only action -> 405", mAction.status === 405, "status=" + mAction.status);
    const mItem = await fetch(base + "api/deployments/" + depId, { method: "PUT" });
    check("PUT on a GET/DELETE resource -> 405", mItem.status === 405, "status=" + mItem.status);
    await fetch(withToken(base + "api/deployments/" + depId), { method: "DELETE" });
  }

  // --- DESK-10: upstream timeout -------------------------------------------
  const t0 = Date.now();
  const rHang = await fetch(base + "api/hang");
  const elapsed = Date.now() - t0;
  check("hanging upstream -> 504", rHang.status === 504, "status=" + rHang.status);
  check("timeout returns promptly", elapsed < 5000, elapsed + "ms");

  // --- DESK-09 / DESK-21: header passthrough -------------------------------
  const rEcho = await fetch(base + "api/echo", {
    headers: {
      authorization: "Bearer test-token",
      "x-custom": "custom-value",
      accept: "application/json",
    },
  });
  const echoed = await rEcho.json();
  check("request authorization forwarded", echoed.headers.authorization === "Bearer test-token",
    String(echoed.headers.authorization));
  check("request x-custom forwarded", echoed.headers["x-custom"] === "custom-value",
    String(echoed.headers["x-custom"]));
  check("request accept forwarded", echoed.headers.accept === "application/json",
    String(echoed.headers.accept));
  check("response content-type forwarded",
    (rEcho.headers.get("content-type") || "").indexOf("application/json") === 0,
    String(rEcho.headers.get("content-type")));
  check("response cache-control forwarded", rEcho.headers.get("cache-control") === "max-age=60",
    String(rEcho.headers.get("cache-control")));
  check("response x-upstream forwarded", rEcho.headers.get("x-upstream") === "yes",
    String(rEcho.headers.get("x-upstream")));
  const rBoom = await fetch(base + "api/boom");
  check("upstream error status forwarded", rBoom.status === 503, "status=" + rBoom.status);

  // --- path traversal regression -------------------------------------------
  const traversal = [
    "/api/../../etc/passwd",
    "/api/%2e%2e/%2e%2e/etc/passwd",
    "/../../etc/passwd",
  ];
  for (const p of traversal) {
    const status = await rawRequest(s.port, p);
    check("path traversal " + p + " -> 404", status === 404, "status=" + status);
  }
  const leaked = upstream.seen.filter((r) => r.url.indexOf("etc/passwd") >= 0);
  check("path traversal never reached upstream", leaked.length === 0,
    JSON.stringify(leaked.map((r) => r.url)));

  // --- main.js security invariants (static: Electron cannot run here) ------
  const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("main.js holds a single-instance lock", mainSrc.indexOf("requestSingleInstanceLock") >= 0);
  check("main.js keeps contextIsolation: true", /contextIsolation:\s*true/.test(mainSrc));
  check("main.js keeps nodeIntegration: false", /nodeIntegration:\s*false/.test(mainSrc));
  check("main.js keeps sandbox: true", /sandbox:\s*true/.test(mainSrc));
  check("main.js keeps setWindowOpenHandler", mainSrc.indexOf("setWindowOpenHandler") >= 0);
  check("main.js keeps the will-navigate allowlist", mainSrc.indexOf("will-navigate") >= 0);

  // --- probe helpers: DESK-22/23/26/27 and the Windows B logic (pure) ------
  check("vendor: M5 without an Apple prefix", classifyGpuVendor("M5 Max") === "apple",
    classifyGpuVendor("M5 Max"));
  check("vendor: Apple hint", classifyGpuVendor("Apple GPU", "Apple") === "apple");
  check("vendor: AMD Radeon", classifyGpuVendor("AMD Radeon RX 7600") === "amd",
    classifyGpuVendor("AMD Radeon RX 7600"));
  check("vendor: Intel Iris Xe", classifyGpuVendor("Intel(R) Iris(R) Xe Graphics") === "intel",
    classifyGpuVendor("Intel(R) Iris(R) Xe Graphics"));
  check("vendor: Qualcomm Adreno", classifyGpuVendor("Qualcomm Adreno 8cx Gen 3") === "qualcomm",
    classifyGpuVendor("Qualcomm Adreno 8cx Gen 3"));
  // Real Windows names carry (TM)/(R)/(C), so the APU-vs-dGPU call is made on
  // the normalized string. A770 is the trap: normalization must not eat digits.
  const umaCases = [
    ["AMD Radeon(TM) Graphics", true],
    ["AMD Radeon (TM) Graphics", true],
    ["AMD Radeon(TM) Vega 8 Graphics", true],
    ["AMD Radeon Graphics", true],
    ["AMD Radeon 780M", true],
    ["AMD Radeon(TM) 760M", true],
    ["AMD Radeon 680M", true],
    ["AMD Radeon 890M", true],
    ["AMD Radeon RX 7600", false],
    ["AMD Radeon RX 7600M", false],
    ["AMD Radeon Pro W6800", false],
    ["NVIDIA GeForce RTX 3060", false],
    ["Intel(R) Arc(TM) Graphics", true],
    ["Intel(R) Arc(TM) A770 Graphics", false],
    ["Intel(R) Arc(TM) A770M Graphics", false],
    ["Intel(R) Iris(R) Xe Graphics", true],
    ["Qualcomm(R) Adreno(TM) X1-85", true],
    ["Microsoft Basic Display Adapter", false],
  ];
  for (const [gpuName, expected] of umaCases) {
    check("UMA " + (expected ? "yes" : "no") + ": " + gpuName,
      windowsGpuIsUma(gpuName) === expected, "got " + windowsGpuIsUma(gpuName));
  }
  check("normalizeGpuName strips (TM)/(R)/(C) and collapses spaces",
    normalizeGpuName("AMD Radeon(TM) Graphics (R) (C)") === "AMD Radeon Graphics",
    normalizeGpuName("AMD Radeon(TM) Graphics (R) (C)"));
  const reg = parseWindowsRegistryGpus(
    "Intel(R) Iris(R) Xe Graphics|134217728\nNVIDIA GeForce RTX 3060|12884901888"
  );
  check("registry: iGPU is UMA with no fake VRAM",
    reg[0] && reg[0].uma === true && reg[0].vram_gb === null && reg[0].vendor === "intel",
    JSON.stringify(reg[0]));
  check("registry: dGPU keeps its VRAM",
    reg[1] && reg[1].uma === false && reg[1].vram_gb === 12 && reg[1].vendor === "nvidia",
    JSON.stringify(reg[1]));
  const smi = parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564\n");
  check("nvidia-smi parser", smi.length === 1 && smi[0].vram_gb === 24 && smi[0].uma === false,
    JSON.stringify(smi));
  check("vm_stat value strips thousands separators",
    parseVmStatValue(" 1,234,567.") === 1234567, String(parseVmStatValue(" 1,234,567.")));
  check("vm_stat sum handles separators",
    sumVmStatPages("Pages free: 1,000.\nPages inactive: 2,000.\nPages speculative: 3.\n") === 3003,
    String(sumVmStatPages("Pages free: 1,000.\nPages inactive: 2,000.\nPages speculative: 3.\n")));
  check("gb keeps a tiny positive value nonzero", gb(1) === 0.1, String(gb(1)));
  check("gb(0) stays null", gb(0) === null, String(gb(0)));
  check("page-size fallback is 4K, never 16K", choosePageSize("", "") === 4096,
    String(choosePageSize("", "")));
  check("page size uses sysctl when present", choosePageSize("4096", "") === 4096,
    String(choosePageSize("4096", "")));
  check("page size reads the vm_stat header when sysctl is empty",
    choosePageSize("", "Mach Virtual Memory Statistics: (page size of 4096 bytes)") === 4096,
    String(choosePageSize("", "Mach Virtual Memory Statistics: (page size of 4096 bytes)")));
  check("page size keeps Apple Silicon 16K when sysctl says so",
    choosePageSize("16384", "") === 16384, String(choosePageSize("16384", "")));

  // --- CSP nonce is substituted per response -------------------------------
  // The page ships a placeholder, not a value. Serving it raw would leave the
  // CSP with a fixed, public nonce - worthless, because this repo is public.
  const META = /script-src 'nonce-([^']+)'/;
  const TAG = /<script nonce="([^"]+)"/;
  const page1 = await (await fetch(base)).text();
  const page2 = await (await fetch(base)).text();
  const nonce1 = (META.exec(page1) || [])[1];
  const nonce2 = (META.exec(page2) || [])[1];
  check("served page has no leftover placeholder",
    !page1.includes("{{CSP_NONCE}}"), page1.includes("{{CSP_NONCE}}") ? "placeholder leaked" : "clean");
  check("meta and script tag carry the SAME nonce",
    !!nonce1 && nonce1 === (TAG.exec(page1) || [])[1],
    'meta=' + nonce1 + ' tag=' + (TAG.exec(page1) || [])[1]);
  check("desktop server issues a fresh nonce per response",
    !!nonce1 && !!nonce2 && nonce1 !== nonce2, nonce1 + " vs " + nonce2);
  const nonces = new Set();
  for (let i = 0; i < 6; i += 1) nonces.add((META.exec(await (await fetch(base)).text()) || [])[1]);
  check("6 responses give 6 distinct nonces", nonces.size === 6, "distinct=" + nonces.size);
  check("/index.html is templated too, not served raw",
    !(await (await fetch(base + "index.html")).text()).includes("{{CSP_NONCE}}"));
  // --- DESK-26: the rejected rows reach the window through the API -------------
  // deploy.js records why a row was dropped. That is only worth anything if the
  // window can actually see it, and the window reads this endpoint.
  const deps = await (await fetch(base + "api/deployments")).json();
  check("DESK-26 /api/deployments 带上了 rejected",
    Array.isArray(deps.rejected), typeof deps.rejected);
  check("DESK-26 被丢弃的行出现在 API 里，且带原因和原值",
    deps.rejected.some((r) => r.id === "dep_bad" && r.reason && r.model_path === "--help"),
    JSON.stringify(deps.rejected));
  // _load() 和 _save() 的合并会各走一遍同样的磁盘行，很容易把同一条记两次。
  check("DESK-26 同一条被拒绝的行只报告一次",
    deps.rejected.filter((r) => r.id === "dep_bad").length === 1,
    "count=" + deps.rejected.filter((r) => r.id === "dep_bad").length);
  check("DESK-26 被丢弃的行不在正常部署列表里",
    !(deps.deployments || []).some((d) => d.id === "dep_bad"),
    JSON.stringify((deps.deployments || []).map((d) => d.id)));

  // --- DESK-29: 本地服务不能被别的页面驱动 --------------------------------
  // loopback 绑定的只挡住了别的机器，挡不住别的页面：用户访问的任何网站都能
  // 往这里发请求，而装机端点是 GET，<img> 就能打。CORS 只管读响应不管发请求。
  function raw(port, path, method, headers, body) {
    return new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: port, path: path, method: method, headers: headers || {} },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        },
      );
      req.on("error", () => resolve({ status: 0, body: "" }));
      if (body) req.write(body);
      req.end();
    });
  }
  const P = s.port;
  const J = JSON.stringify({ backend: "ollama", model_name: "csrf", model_id: "csrf" });
  const hostHdr = { host: "127.0.0.1:" + P };

  // <img src="/api/backends/x/install"> 是 no-cors，**不带 Origin 头**。
  // 这就是为什么只查 Origin 不够，必须有 token。
  const imgInstall = await raw(P, "/api/backends/ollama/install", "GET", hostHdr);
  check("DESK-29 <img> 式装机请求（无 Origin，无 token）被 token 层拒绝",
    imgInstall.status === 403 && imgInstall.body.indexOf("token") >= 0, imgInstall.body);

  const okInstall = await raw(P,
    "/api/backends/nonexistent/install?token=" + encodeURIComponent(TOKEN), "GET", hostHdr);
  check("DESK-29 带 token 的装机请求不被拦（功能没被关掉）",
    okInstall.status === 200, "status=" + okInstall.status);

  const xo = await raw(P, "/api/deployments", "POST", Object.assign({
    origin: "https://evil.example",
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(J),
  }, hostHdr), J);
  // 断言必须钉住「哪一层拒的」：token 层也会返回 403，只看状态码的话
  // Origin 闸门整个删掉测试也照样全绿。
  check("DESK-29 跨源 POST 被来源闸门拒绝（不是被 token 挡的）",
    xo.status === 403 && xo.body.indexOf("cross-origin") >= 0, xo.body);

  // DNS rebinding：页面在 evil.example，解析到 127.0.0.1，于是请求真的来自
  // 回环地址，但 Host 头还是 evil.example。
  const rebind = await raw(P, "/api/deployments", "POST", {
    host: "evil.example:" + P,
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(J),
  }, J);
  check("DESK-29 DNS rebinding 被 Host 检查拒绝（不是被 token 挡的）",
    rebind.status === 403 && rebind.body.indexOf("cross-origin") >= 0, rebind.body);

  const noToken = await raw(P, "/api/deployments", "POST", Object.assign({
    origin: "http://127.0.0.1:" + P,
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(J),
  }, hostHdr), J);
  check("DESK-29 同源但缺 token 被 token 层拒绝",
    noToken.status === 403 && noToken.body.indexOf("token") >= 0, noToken.body);

  const withTok = await raw(P, "/api/deployments?token=" + encodeURIComponent(TOKEN), "POST",
    Object.assign({
      origin: "http://127.0.0.1:" + P,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(J),
    }, hostHdr), J);
  check("DESK-29 同源 + token 放行", withTok.status === 200, "status=" + withTok.status);

  const pageHtml = await (await fetch(base)).text();
  check("DESK-29 页面里注入的是真实 token",
    TOKEN.length > 20 && pageHtml.indexOf(TOKEN) >= 0, "len=" + TOKEN.length);
  check("DESK-29 页面里不残留 token 占位符",
    pageHtml.indexOf("{{API_TOKEN}}") < 0);
  // token 是每进程一个（不是每响应一个）：页面刷新后旧的 token 不该失效。
  const pageAgain = await (await fetch(base)).text();
  check("DESK-29 token 每进程固定，不随响应变化",
    /API_TOKEN='([^']*)'/.exec(pageAgain)[1] === TOKEN);

  // --- DESK-31: 创建时要知道端口是不是真的被占着 ---------------------------
  // 记录只能说明「本应用自己的部署」，说明不了 Ollama 守护进程 —— 而正好是它占着
  // 11434，被指过去的那个 llama.cpp 部署永远绑不上。
  const net = require("node:net");
  const busySrv = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const busy = busySrv.address().port;
  const probeGguf = path.join(dataDir, "probe.gguf");
  fs.writeFileSync(probeGguf, "placeholder");
  const postDep = (body) => fetch(withToken(base + "api/deployments"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const clashRes = await postDep({ backend: "llama.cpp", model_path: probeGguf, port: busy });
  const clashBody = await clashRes.json().catch(() => null);
  check("DESK-31 端口被别的程序占用时创建被拒",
    clashRes.status === 400 && String(clashBody && clashBody.detail).indexOf("占用") >= 0,
    clashRes.status + " " + JSON.stringify(clashBody));

  // Ollama 例外：所有 ollama 部署共用那个守护进程，11434「被占用」才是正常的。
  const okOllama = await postDep({ backend: "ollama", model_name: "qwen3:8b" });
  const okOllamaBody = await okOllama.json().catch(() => null);
  check("DESK-31 ollama 不被端口探测误伤（它本来就该占着 11434）",
    okOllama.status === 200, okOllama.status + " " + JSON.stringify(okOllamaBody));
  busySrv.close();


  // --- DESK-32：一键下载走的是真网络 --------------------------------------
  // 这一组是真的去问 HuggingFace，所以它同时验证了「仓库 id 形状校验 → 列文件
  // → 挑量化 → 拼 URL」整条链。纯匹配规则在 test-gguf.js 里已单独测过。
  const ggufPlan = (repo, quant, tok) => {
    const u = base + "api/models/gguf/plan?repo=" + encodeURIComponent(repo) +
      "&quant=" + encodeURIComponent(quant);
    // withToken 拼的是完整 URL，不是 base —— 拼错了整个路径就没了。
    return fetch(tok === false ? u : withToken(u));
  };

  const gOk = await ggufPlan("Qwen/Qwen3-8B-GGUF", "q4_k_m");
  const gOkBody = await gOk.json();
  check("DESK-32 plan 选出了正确的量化文件",
    gOk.status === 200 && gOkBody.files.length === 1 &&
    gOkBody.files[0].name === "Qwen3-8B-Q4_K_M.gguf",
    gOk.status + " " + JSON.stringify((gOkBody.files || []).map((f) => f.name)));
  check("DESK-32 plan 报出真实大小",
    gOkBody.bytes > 4e9 && gOkBody.bytes < 6e9, String(gOkBody.bytes));
  check("DESK-32 model_path 指向下载后的本机文件",
    gOkBody.needs_download === true &&
    gOkBody.model_path.endsWith("Qwen3-8B-Q4_K_M.gguf") &&
    gOkBody.model_path.indexOf("huggingface") < 0, gOkBody.model_path);

  const gShard = await (await ggufPlan("Qwen/Qwen2.5-7B-Instruct-GGUF", "q4_k_m")).json();
  check("DESK-32 分片仓库会把每一片都列出来",
    gShard.files.length === 2 &&
    gShard.files[0].name.endsWith("00001-of-00002.gguf") &&
    gShard.files[1].name.endsWith("00002-of-00002.gguf"),
    JSON.stringify((gShard.files || []).map((f) => f.name)));

  const gQuant = await ggufPlan("Qwen/Qwen3-8B-GGUF", "q9_z_z");
  const gQuantBody = await gQuant.json();
  check("DESK-32 仓库里没有这个量化时给 400 并说清楚",
    gQuant.status === 400 && String(gQuantBody.detail).indexOf("没有") >= 0,
    gQuant.status + " " + String(gQuantBody.detail));

  const gBad = await ggufPlan("../../etc", "q4_k_m");
  check("DESK-32 非法仓库 id 在发请求前就被拒",
    gBad.status === 400 && String((await gBad.json()).detail).indexOf("仓库 id") >= 0, String(gBad.status));

  const gNoTok = await ggufPlan("Qwen/Qwen3-8B-GGUF", "q4_k_m", false);
  check("DESK-32 plan 也要 token", gNoTok.status === 403, String(gNoTok.status));

  // 下载端点是 GET + 写磁盘，所以它是 <img> 能触发的那种请求，token 是唯一
  // 拦得住它的东西。无 token 必须被挡在写第一个字节之前。
  const gDlNoTok = await fetch(base +
    "api/models/gguf/download?repo=" + encodeURIComponent("Qwen/Qwen3-8B-GGUF") + "&quant=q4_k_m");
  const gDlBody = await gDlNoTok.text();
  check("DESK-32 无 token 的下载请求被拒，且没有开始下载",
    gDlNoTok.status === 403 && gDlBody.indexOf("event-stream") < 0,
    gDlNoTok.status + " " + gDlBody.slice(0, 60));

  await s.close();
  upstream.server.closeAllConnections();
  upstream.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("test-server crashed:", e && e.stack);
  process.exit(1);
});
