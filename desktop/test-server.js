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
  const s = await start(0, { dataDir });
  const base = s.url;
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
  const created = await (await fetch(base + "api/deployments", {
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
    await fetch(base + "api/deployments/" + depId, { method: "DELETE" });
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
