"use strict";

// Drives the real frontend/index.html in a real Electron window.
//
// Covers the Docker deploy form (docs/docker-design.md §8) and the frontend QA
// regressions F-03..F-13. The control plane is only used to serve the page:
// every API call the assertions depend on is stubbed via window.fetch, so the
// test is deterministic and needs no Docker on this machine.
//
//   MDP_URL=http://127.0.0.1:8790 ./node_modules/.bin/electron test-frontend.js

const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
// The page is served over HTTP; without this Electron may hand back a stale
// cached index.html from an earlier run instead of the file on disk.
app.commandLine.appendSwitch("disable-http-cache");

const URL = process.env.MDP_URL || "http://127.0.0.1:8790";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
  if (ok) pass += 1;
  else fail += 1;
}

// Replaces window.fetch with a canned router. Every request is recorded in
// window.__CAP so a test can assert what createDeploy actually sent.
const INSTALL = `(() => {
  window.__CAP = [];
  window.__DEPS = [];
  window.__REC = null;
  window.__CONFIG = null;
  const json = (obj, ok, status) => Promise.resolve({ ok: ok === undefined ? true : ok, status: status || 200, json: () => Promise.resolve(obj) });
  window.fetch = function (url, opts) {
    opts = opts || {};
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    window.__CAP.push({ url: u, method: method, body: opts.body || null });
    if (u === '/api/deployments' && method === 'GET') return json({ deployments: window.__DEPS });
    if (u === '/api/deployments' && method === 'POST') return json({ id: 'dep_new' });
    if (u.indexOf('/api/deployments/') === 0) return json({});
    if (u === '/api/models/recommend') return json(window.__REC || {});
    if (u === '/api/environment/latest') return json({});
    if (u === '/api/backends') return json(window.__CONFIG || {});
    if (u === '/api/hardware/resolve') return json({ budget: {}, normalized: {} });
    return json({});
  };
  window.__stubFetch = window.fetch;
  clearTimeout(window.__depPoll);
  return true;
})()`;

async function loadWithRetry(win) {
  // Bust both the disk cache and any HTTP cache keyed on the bare URL.
  const bust = URL + (URL.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
  for (let i = 0; i < 3; i += 1) {
    try {
      await win.webContents.session.clearCache();
      await win.loadURL(bust);
      return;
    } catch (e) {
      if (i === 2) throw e;
      await sleep(2500);
    }
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 980, show: false });
  win.webContents.on("console-message", (e, level, message) => {
    if (level >= 2) console.log("  [renderer] " + message);
  });
  const run = (js) => win.webContents.executeJavaScript(js);
  try {
    await loadWithRetry(win);
  } catch (e) {
    console.log("  FAIL  打不开 " + URL + "：" + e.message);
    app.exit(1);
    return;
  }
  await sleep(2500);
  await run(INSTALL);
  await sleep(200);

  // --- F-11: every label points at a real control -------------------------
  const labels = await run(`(() => {
    const all = [...document.querySelectorAll('label')];
    const noFor = all.filter((l) => !l.getAttribute('for')).map((l) => l.textContent.trim());
    const dangling = all.filter((l) => l.getAttribute('for') && !document.getElementById(l.getAttribute('for'))).map((l) => l.getAttribute('for'));
    return { total: all.length, noFor, dangling };
  })()`);
  check("label 全部带 for", labels.total > 0 && labels.noFor.length === 0, "共 " + labels.total + " 个，缺 for：" + labels.noFor.join(","));
  check("label 的 for 都指向存在的控件", labels.dangling.length === 0, labels.dangling.join(","));

  // --- F-12: id="service" has an entry -----------------------------------
  const svc = await run(`(() => {
    const a = [...document.querySelectorAll('#deploy .head a')].find((x) => x.textContent.indexOf('服务测试') >= 0);
    if (!a) return { found: false };
    a.click();
    return { found: true, target: !!document.getElementById('service') };
  })()`);
  check("服务测试有入口且 #service 存在", svc.found === true && svc.target === true);

  // --- Docker block visibility + macOS warning ----------------------------
  const vis = await run(`(() => {
    window.CONFIG = { backends: ['docker', 'ollama'], installable: {}, unavailable: {}, local: true, caps: { platform: 'darwin', docker: true, nvidia: false } };
    fillBackends();
    const sel = document.getElementById('d-backend');
    const block = document.getElementById('d-docker');
    const before = block.style.display;
    sel.value = 'docker'; sel.dispatchEvent(new Event('change'));
    const shown = block.style.display;
    const warn = document.getElementById('d-docker-warn');
    const warnShown = warn.style.display !== 'none' && warn.textContent.length > 0;
    const warnText = warn.textContent;
    sel.value = 'ollama'; sel.dispatchEvent(new Event('change'));
    const hidden = block.style.display;
    return { before, shown, hidden, warnShown, warnText };
  })()`);
  check("docker 区块默认隐藏", vis.before === "none", vis.before);
  check("选 docker 后显示", vis.shown !== "none", vis.shown);
  check("选回 ollama 后隐藏", vis.hidden === "none", vis.hidden);
  check("macOS 桌面端提示容器拿不到 GPU", vis.warnShown === true && /GPU/.test(vis.warnText), vis.warnText.slice(0, 40));

  const noWarn = await run(`(() => {
    window.CONFIG.caps = { platform: 'linux', docker: true, nvidia: true };
    updateDockerBlock();
    const warn = document.getElementById('d-docker-warn');
    return { shown: warn.style.display !== 'none' };
  })()`);
  check("非 macOS 不显示 Mac 专属警告", noWarn.shown === false);

  // An unavailable docker entry must not leave the docker block on screen: the
  // select reverts and opens the install dialog instead.
  const reverted = await run(`(() => {
    window.CONFIG = { backends: ['ollama'], installable: {}, unavailable: {}, local: true, caps: { platform: 'darwin', docker: false, nvidia: false } };
    fillBackends();
    const sel = document.getElementById('d-backend');
    sel.value = 'docker'; sel.dispatchEvent(new Event('change'));
    const block = document.getElementById('d-docker');
    const modalOpen = getComputedStyle(document.getElementById('modal')).display !== 'none';
    const selected = sel.value;
    closeModal();
    return { block: block.style.display, modalOpen, selected };
  })()`);
  check("不可用 docker 回退后区块隐藏且弹框打开",
    reverted.block === "none" && reverted.modalOpen === true && reverted.selected === "ollama", JSON.stringify(reverted));

  // --- createDeploy: docker request body ----------------------------------
  const dockerBody = await run(`(async () => { try {
    window.CONFIG = { backends: ['docker', 'ollama'], installable: {}, unavailable: {}, local: true, caps: { platform: 'darwin', docker: true, nvidia: false } };
    fillBackends();
    const sel = document.getElementById('d-backend');
    sel.value = 'docker'; sel.dispatchEvent(new Event('change'));
    document.getElementById('d-image').value = 'vllm/vllm-openai:latest';
    document.getElementById('d-gpus').value = '0,1';
    document.getElementById('d-port').value = '8000';
    document.getElementById('d-path').value = 'Qwen/Qwen3-8B';
    document.getElementById('d-volumes').value = ['/Users/me/My Models:/models:ro', '', '/Users/me/data:/data', ''].join(String.fromCharCode(10));
    document.getElementById('d-extra').value = ['--max-model-len', '65536', '', '--served-model-name My Model', ''].join(String.fromCharCode(10));
    window.__CAP.length = 0;
    await createDeploy();
    const post = window.__CAP.filter((c) => c.url === '/api/deployments' && c.method === 'POST')[0];
    return post ? JSON.parse(post.body) : null;
  } catch (e) { return { __error: String((e && e.stack) || e) }; } })()`);
  if (dockerBody && dockerBody.__error) console.log("  [debug] dockerBody: " + dockerBody.__error);
  check("docker 请求体 image 正确", dockerBody && dockerBody.image === "vllm/vllm-openai:latest", dockerBody && dockerBody.image);
  check("docker 请求体 gpus 正确", dockerBody && dockerBody.gpus === "0,1", dockerBody && dockerBody.gpus);
  check("docker 请求体 volumes 解析正确（空格路径 + ro + 空行）",
    !!dockerBody && JSON.stringify(dockerBody.volumes) === JSON.stringify([
      { host: "/Users/me/My Models", container: "/models", ro: true },
      { host: "/Users/me/data", container: "/data", ro: false },
    ]), dockerBody && JSON.stringify(dockerBody.volumes));
  check("docker 请求体 extra_args 按行解析（保留带空格参数）",
    !!dockerBody && JSON.stringify(dockerBody.extra_args) === JSON.stringify(["--max-model-len", "65536", "--served-model-name My Model"]),
    dockerBody && JSON.stringify(dockerBody.extra_args));

  const nonDocker = await run(`(async () => {
    const sel = document.getElementById('d-backend');
    sel.value = 'ollama'; sel.dispatchEvent(new Event('change'));
    document.getElementById('d-port').value = '11434';
    window.__CAP.length = 0;
    await createDeploy();
    const post = window.__CAP.filter((c) => c.url === '/api/deployments' && c.method === 'POST')[0];
    return post ? JSON.parse(post.body) : null;
  })()`);
  check("非 docker 后端不塞 docker 字段",
    !!nonDocker && nonDocker.backend === "ollama" && !("image" in nonDocker) && !("volumes" in nonDocker) && !("gpus" in nonDocker) && !("extra_args" in nonDocker),
    nonDocker && JSON.stringify(Object.keys(nonDocker)));

  // --- parsing units -------------------------------------------------------
  const parsed = await run(`(() => {
    const v = parseVolumes(['/a/My Models:/models:ro', '', '/b:/c', 'relative:/x'].join(String.fromCharCode(10)));
    const e = parseExtraArgs(['--a', '', '  --b  ', ''].join(String.fromCharCode(10)));
    return { volumes: v.volumes, verrors: v.errors, args: e.args };
  })()`);
  check("parseVolumes 支持空格路径与 ro", JSON.stringify(parsed.volumes) === JSON.stringify([
    { host: "/a/My Models", container: "/models", ro: true },
    { host: "/b", container: "/c", ro: false },
  ]), JSON.stringify(parsed.volumes));
  check("parseVolumes 拒绝非绝对路径", parsed.verrors.length === 1, JSON.stringify(parsed.verrors));
  check("parseExtraArgs 去掉空行", JSON.stringify(parsed.args) === JSON.stringify(["--a", "--b"]), JSON.stringify(parsed.args));

  // --- F-07: incompatible models are not offered ---------------------------
  const models = await run(`(() => {
    fillDeployModels({ recommendations: [
      { id: 'good-model', name: 'Good Model', quantization: 'q4', fits: true, reason_key: 'recommended', source: {} },
      { id: 'bad-model', name: 'Bad Model', quantization: 'awq', fits: true, reason_key: 'backend-incompatible', source: {} }
    ] });
    return { count: document.getElementById('d-model').options.length, models: DEPLOY_MODELS.map((m) => m.id) };
  })()`);
  check("不兼容模型不出现在部署下拉", models.count === 1 && models.models.join(",") === "good-model", models.models.join(","));

  // --- F-06: polling keeps the selected instance ---------------------------
  const poll = await run(`(async () => {
    window.__DEPS = [
      { id: 'dep_1', model_path: 'm1', backend: 'llama.cpp', status: 'STARTING', endpoint: 'e1', health_endpoint: 'h1', log: [] },
      { id: 'dep_2', model_path: 'm2', backend: 'llama.cpp', status: 'STOPPED', endpoint: 'e2', health_endpoint: 'h2', log: [] }
    ];
    await refreshDeployments();
    const sel = document.getElementById('t-dep');
    sel.selectedIndex = 1; sel.dispatchEvent(new Event('change'));
    const picked = sel.value;
    const modelAfterPick = document.getElementById('t-model').value;
    await refreshDeployments();
    clearTimeout(window.__depPoll);
    return { picked, modelAfterPick, after: sel.value, modelAfterPoll: document.getElementById('t-model').value };
  })()`);
  check("轮询不重置 t-dep 选择", poll.picked === "dep_2" && poll.after === "dep_2", poll.picked + " -> " + poll.after);
  check("轮询不改写已选实例的 t-model", poll.modelAfterPick === "m2" && poll.modelAfterPoll === "m2", poll.modelAfterPick + " -> " + poll.modelAfterPoll);

  // --- F-10: invalid port / max tokens blocked before submit ---------------
  const port0 = await run(`(async () => {
    const sel = document.getElementById('d-backend'); sel.value = 'docker'; sel.dispatchEvent(new Event('change'));
    document.getElementById('d-port').value = '0';
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.url === '/api/deployments' && c.method === 'POST'), log: document.getElementById('d-log').textContent };
  })()`);
  check("端口 0 提交前被拦", port0.posted === false && port0.log.indexOf("端口") >= 0, port0.log.slice(0, 40));

  const portNaN = await run(`(async () => {
    document.getElementById('d-port').value = 'abc';
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.url === '/api/deployments' && c.method === 'POST') };
  })()`);
  check("非数字端口提交前被拦", portNaN.posted === false);

  const tmax = await run(`(async () => {
    document.getElementById('d-port').value = '8000';
    const sel = document.getElementById('t-dep');
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
    document.getElementById('t-max').value = 'abc';
    window.__CAP.length = 0;
    await runTest();
    return { posted: window.__CAP.some((c) => c.url.indexOf('/test') >= 0), out: document.getElementById('t-out').textContent };
  })()`);
  check("非法 Token 提交前被拦", tmax.posted === false && tmax.out.indexOf("Token") >= 0, tmax.out.slice(0, 40));

  // --- F-03: backend down resets status and hardware card ------------------
  const down = await run(`(async () => {
    document.getElementById('status-text').textContent = '正在检测…';
    document.getElementById('status-dot').className = 'dot';
    document.getElementById('hw-device').textContent = 'OLD DEVICE';
    document.getElementById('hw-budget').textContent = '999 GB';
    const of = window.fetch;
    window.fetch = function () { return Promise.reject(new Error('down')); };
    await refresh();
    window.fetch = of;
    return {
      statusText: document.getElementById('status-text').textContent,
      dot: document.getElementById('status-dot').className,
      device: document.getElementById('hw-device').textContent,
      budget: document.getElementById('hw-budget').textContent,
    };
  })()`);
  check("后端不可用时状态行不再停在「正在检测…」", down.statusText !== "正在检测…" && down.dot === "dot", down.statusText);
  check("后端不可用时硬件卡片被重置", down.device === "—" && down.budget === "—", down.device + " / " + down.budget);

  // --- F-04 / F-05: no unhandled rejections --------------------------------
  const health = await run(`(async () => {
    window.__DEPS = [{ id: 'dep_h', model_path: 'm', backend: 'llama.cpp', status: 'STOPPED', endpoint: 'e', health_endpoint: 'h', log: [] }];
    await refreshDeployments();
    const sel = document.getElementById('t-dep');
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
    const of = window.fetch;
    window.fetch = function () { return Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('bad json')) }); };
    await healthCheck();
    const out500 = document.getElementById('t-out').textContent;
    const rej = [];
    const h = (e) => { rej.push(String(e.reason)); };
    window.addEventListener('unhandledrejection', h);
    window.fetch = function () { return Promise.reject(new Error('netdown')); };
    healthCheck();
    await new Promise((r) => setTimeout(r, 100));
    window.removeEventListener('unhandledrejection', h);
    window.fetch = of;
    return { out500, rej, outNet: document.getElementById('t-out').textContent };
  })()`);
  check("healthCheck 对 500 给出反馈", health.out500.indexOf("健康检查失败") >= 0, health.out500.slice(0, 40));
  check("healthCheck 网络失败不产生 unhandled rejection", health.rej.length === 0 && health.outNet.indexOf("健康检查失败") >= 0, health.rej.join(","));

  const start = await run(`(async () => {
    const of = window.fetch;
    const rej = [];
    const h = (e) => { rej.push(String(e.reason)); };
    window.addEventListener('unhandledrejection', h);
    window.fetch = function () { return Promise.reject(new Error('netdown')); };
    depStart('dep_1');
    await new Promise((r) => setTimeout(r, 100));
    window.removeEventListener('unhandledrejection', h);
    window.fetch = of;
    return { rej, log: document.getElementById('d-log').textContent };
  })()`);
  check("depStart 网络失败不产生 unhandled rejection 且有提示", start.rej.length === 0 && start.log.indexOf("启动失败") >= 0, start.rej.join(",") + " | " + start.log.slice(0, 30));

  // --- confidence + corrected device label (docs/probe-session-design.md §1/§6)
  const conf1 = await run(`(async () => {
    window.__REC = {
      hardware: { device_name: 'NVIDIA GeForce RTX 3060', uma: false, total_device_gb: 12, usable_vram_gb: 10 },
      normalized_profile: { architecture: 'x86_64', confidence: 'unverified' },
      hardware_source: 'client:browser', hardware_trusted: false, client_is_local: false,
      confidence: 'unverified', recommendations: [], hardware_warnings: []
    };
    await refresh();
    return {
      type: document.getElementById('hw-type').textContent,
      typeHTML: document.getElementById('hw-type').innerHTML,
      arch: document.getElementById('hw-arch').textContent,
      conf: document.getElementById('hw-confidence').textContent
    };
  })()`);
  check("设备行显示「独立显存 · 12 GB」而不是 unknown", conf1.type.indexOf("独立显存 · 12 GB") >= 0, conf1.type);
  check("查表值有「不对？改」入口", conf1.typeHTML.indexOf("不对？改") >= 0);
  check("CPU 架构单独一行", conf1.arch === "CPU 架构 · x86_64", conf1.arch);
  check("confidence=unverified 文案正确", conf1.conf === "按型号查表，未实测", conf1.conf);

  const conf2 = await run(`(async () => {
    window.__REC.confidence = 'disputed';
    await refresh();
    const el = document.getElementById('hw-confidence');
    return { conf: el.textContent, cls: el.className };
  })()`);
  check("confidence=disputed 用 warn 样式", conf2.conf === "与型号标称不符，请确认" && conf2.cls.indexOf("warn") >= 0, conf2.conf + " / " + conf2.cls);

  const conf3 = await run(`(async () => {
    window.__REC = {
      hardware: { device_name: 'Apple M5', uma: true, total_device_gb: 24, usable_vram_gb: 19.2 },
      normalized_profile: { architecture: 'unknown' },
      hardware_source: 'server', hardware_trusted: true, client_is_local: true,
      recommendations: [], hardware_warnings: []
    };
    await refresh();
    return {
      conf: document.getElementById('hw-confidence').textContent,
      confDisplay: document.getElementById('hw-confidence').style.display,
      arch: document.getElementById('hw-arch').style.display,
      type: document.getElementById('hw-type').textContent
    };
  })()`);
  check("confidence 缺失时优雅降级", conf3.conf === "" && conf3.confDisplay === "none", conf3.conf);
  check("architecture=unknown 不渲染", conf3.arch === "none");
  check("统一内存显示容量", conf3.type.indexOf("统一内存 · 24 GB") >= 0, conf3.type);

  // --- S1: deployment actions no longer splice the id into inline JS -------
  const s1 = await run(`(() => {
    window.__DEPS = [{ id: 'dep_x', model_path: 'm', backend: 'llama.cpp', status: 'STOPPED', endpoint: 'e', health_endpoint: 'h', log: [] }];
    return refreshDeployments().then(() => {
      const buttons = [...document.querySelectorAll('#d-list button')];
      return { n: buttons.length, actions: buttons.map((b) => b.getAttribute('data-dep-action')), inline: buttons.some((b) => b.hasAttribute('onclick')) };
    });
  })()`);
  check("部署操作走 data 属性而不是裸拼 onclick", s1.n === 4 && s1.inline === false && s1.actions.join(",") === "start,stop,logs,delete", s1.actions.join(","));

  console.log("\n" + pass + " passed, " + fail + " failed");
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error("FAILED:", e && e.stack || e); app.exit(1); });
