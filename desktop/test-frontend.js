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

  // --- 控制面是不可信的，页面不能去外面取脚本/帧/对象 ---------------------
  // Electron 在开发模式下会警告这个页面没有 CSP。警告本身只在未打包时出现，
  // 但「没有 CSP」这个事实一直都在，所以这里断言它真的存在、真的生效。
  const csp = await run(`(async () => {
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const c = m ? m.getAttribute('content') : '';
    // 无网络也能确定性验证：脚本源没有 unsafe-eval，eval 必须被拒。
    let evalBlocked = false;
    try { (0, eval)('1+1'); } catch (e) { evalBlocked = String(e).indexOf('EvalError') >= 0 || String(e).length > 0; }
    let sameOk = false;
    try { const r = await fetch('/api/health'); sameOk = !!r; } catch (e) { sameOk = false; }
    return { has: !!m, c, evalBlocked, sameOk };
  })()`);
  check("页面设置了 Content-Security-Policy", csp.has === true);
  check("CSP 默认拒绝（default-src none）且禁用 object/base/form",
    /default-src 'none'/.test(csp.c) && /object-src 'none'/.test(csp.c) &&
    /base-uri 'none'/.test(csp.c) && /form-action 'none'/.test(csp.c), csp.c.slice(0, 80));
  check("CSP 限制 connect-src 为同源", /'self'/.test(csp.c) && /connect-src/.test(csp.c), csp.c.slice(0, 80));
  check("CSP 真的在生效（eval 被拒）", csp.evalBlocked === true);
  check("CSP 没有把同源请求一起挡掉", csp.sameOk === true);
  // console.warn 在 meta 里是无效指令，写上去只会假装有保护。
  check("CSP 没有写 meta 里无效的指令（frame-ancestors / sandbox）",
    csp.c.indexOf('frame-ancestors') < 0 && csp.c.indexOf('sandbox') < 0, csp.c.slice(0, 80));

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

  // --- GPU 默认值必须匹配这台机器 ---------------------------------------
  // 默认请求 `--gpus all` 在拿不到 GPU 的机器上不只是无用：Docker 会先把整个
  // 镜像拉下来，然后才报 could not select device driver —— 用户白等一次多 GB 下载。
  const gpuDefault = await run(`(() => {
    window.CONFIG = { backends: ['docker', 'ollama'], installable: {}, unavailable: {}, local: true,
      caps: { platform: 'darwin', docker: true, nvidia: false } };
    fillBackends();
    const b = document.getElementById('d-backend');
    b.value = 'docker'; b.dispatchEvent(new Event('change'));
    const g = document.getElementById('d-gpus');
    g.removeAttribute('data-touched');
    updateDockerBlock();
    const mac = g.value;
    window.CONFIG.caps = { platform: 'linux', docker: true, nvidia: true };
    g.removeAttribute('data-touched');
    updateDockerBlock();
    const linux = g.value;
    g.value = 'none'; g.setAttribute('data-touched', '1');
    updateDockerBlock();
    const kept = g.value;
    g.removeAttribute('data-touched');
    window.CONFIG.caps = { platform: 'darwin', docker: true, nvidia: false };
    return { mac, linux, kept, hasTouchedAttr: document.getElementById('d-gpus').getAttribute('onchange') !== null };
  })()`);
  check("macOS 上 GPU 默认 none（all 在这里必然失败）", gpuDefault.mac === 'none', gpuDefault.mac);
  check("Linux + NVIDIA 上 GPU 默认 all", gpuDefault.linux === 'all', gpuDefault.linux);
  check("用户显式改过之后不再被覆盖", gpuDefault.kept === 'none', gpuDefault.kept);
  check("GPU 控件带 onchange 以便记录用户的选择", gpuDefault.hasTouchedAttr === true);

  // macOS 的警告必须说清楚「默认镜像在这里起不来」，否则用户会照着默认值点下去。
  const macWarnText = await run(`(() => {
    window.CONFIG = { backends: ['docker', 'ollama'], installable: {}, unavailable: {}, local: true,
      caps: { platform: 'darwin', docker: true, nvidia: false } };
    fillBackends();
    const b = document.getElementById('d-backend');
    b.value = 'docker'; b.dispatchEvent(new Event('change'));
    const t = document.getElementById('d-docker-warn').textContent;
    return { t };
  })()`);
  check("macOS 警告点名 vllm/vllm-openai 并给出实测依据",
    macWarnText.t.indexOf('vllm/vllm-openai') >= 0 && /could not select device driver/.test(macWarnText.t),
    macWarnText.t.slice(0, 120));
  // 实测过的（--gpus all 报错）和推断的（CUDA 镜像起不来）必须分开说，
  // 否则和这个分支一直以来的毛病一样：把假设写成事实。
  check("macOS 警告把「推断」和「实测」分开标注",
    macWarnText.t.indexOf('实测') >= 0 && macWarnText.t.indexOf('推断') >= 0,
    macWarnText.t.slice(0, 160));

  // 警告不能只说「你的镜像不行」：CPU 路径是通的，还要给出实测可用的替代。
  // 也**不能**再说「容器在 Mac 上不通」—— 真容器已经跑到能推理了。
  check("macOS 警告给出实测可用的 CPU 镜像",
    macWarnText.t.indexOf('ghcr.io/ggml-org/llama.cpp:server') >= 0,
    macWarnText.t.slice(-70));
  check("macOS 警告不再宣称「容器在 Mac 上不通」",
    macWarnText.t.indexOf('容器这条路在 Mac 上不通') < 0,
    macWarnText.t.slice(0, 70));

  // --- 预览必须和真正会执行的命令一致 -------------------------------------
  // advisory 预览以前自己拼请求、不带 docker 字段，于是它打印 --gpus all 和默认镜像，
  // 而真正部署用的是用户的选择 —— 告诉用户去复制的那条命令，不是这个应用会跑的命令。
  const adv = await run(`(async () => {
    window.__CAP.length = 0;
    window.CONFIG = { backends: ['docker', 'ollama'], installable: {}, unavailable: {}, local: true,
      allow_remote_deploy: false, caps: { platform: 'darwin', docker: true, nvidia: false } };
    LAST = { client_is_local: false };
    fillBackends();
    const b = document.getElementById('d-backend');
    b.value = 'docker'; b.dispatchEvent(new Event('change'));
    updateDockerBlock();
    document.getElementById('d-image').value = 'my/cpu-image:1';
    document.getElementById('d-volumes').value = '/tmp/models:/models:ro';
    document.getElementById('d-extra').value = '--max-model-len' + String.fromCharCode(10) + '4096';
    await refreshAdvisory();
    const p = window.__CAP.filter(c => c.url === '/api/plans/preview').pop();
    return { sent: p ? JSON.parse(p.body) : null, shown: document.getElementById('d-gpus').value };
  })()`);
  check("advisory 预览发出用户选的 GPU（不再写死 all）",
    !!adv.sent && adv.sent.gpus === 'none', adv.sent && adv.sent.gpus);
  check("advisory 预览发出用户填的镜像",
    !!adv.sent && adv.sent.image === 'my/cpu-image:1', adv.sent && adv.sent.image);
  check("advisory 预览发出数据卷",
    !!adv.sent && (adv.sent.volumes || []).length === 1, JSON.stringify(adv.sent && adv.sent.volumes));
  check("advisory 预览发出额外参数",
    !!adv.sent && (adv.sent.extra_args || []).length === 2, JSON.stringify(adv.sent && adv.sent.extra_args));
  // 真正部署时两边必须用同一份字段：同一个函数产出的值。
  const sameFields = await run(`(() => {
    const df = dockerFields();
    return { image: df.image, gpus: df.gpus, volumes: df.volumes.length, extra: df.extra_args.length, errs: df.errors.length };
  })()`);
  check("dockerFields() 与预览/部署共用同一份值",
    sameFields.image === 'my/cpu-image:1' && sameFields.gpus === 'none' && sameFields.volumes === 1 && sameFields.extra === 2,
    JSON.stringify(sameFields));

  // --- a pulled Docker image must read as ready, not as "install again" ------
  // The one-click install chain used to end nowhere: after `docker pull` the UI
  // still showed the same install offer, with no sign the image was local and no
  // pointer at the backend that actually runs it.
  const ready = await run(`(() => {
    window.CONFIG = {
      backends: ['docker', 'ollama'], local: true,
      caps: { platform: 'linux', docker: true, nvidia: true },
      unavailable: {},
      installable: { vllm: {
        info: 'x', steps: [], manual: 'docker pull vllm/vllm-openai:latest',
        via: 'docker', image: 'vllm/vllm-openai:latest', alreadyInstalled: true,
        note: '官方镜像 vllm/vllm-openai:latest 已在本地，无需重新拉取。部署请用 docker 后端。',
        gpu: 'g' } },
    };
    fillBackends();
    const note = backendNote('vllm');
    openInstallModal('vllm');
    const body = document.getElementById('m-body').textContent;
    const actions = document.getElementById('m-actions');
    const shown = getComputedStyle(document.getElementById('modal')).display !== 'none';
    const hasInstallBtn = !!document.getElementById('m-install');
    const hasCloseBtn = !!document.getElementById('m-close5');
    closeModal();
    return { note, body, shown, hasInstallBtn, hasCloseBtn };
  })()`);
  check("已拉取的镜像在下拉里标为「镜像已就绪」", /镜像已就绪/.test(ready.note), ready.note);
  check("已就绪时弹框打开且状态是「已在本地」", ready.shown === true && ready.body.indexOf('官方镜像已在本地') >= 0);
  check("已就绪时不再显示「确认安装」按钮", ready.hasInstallBtn === false);
  check("已就绪时说明里指向 docker 后端", ready.body.indexOf('docker 后端') >= 0);
  check("已就绪时不再列出将执行的步骤，显示「无需操作」", ready.body.indexOf('无需操作') >= 0);

  // 关键：不能只说「无需操作」就把用户丢下。按钮要真的把人送到部署表单，
  // 并且把镜像填成刚装好的那个。
  const jumped = await run(`(() => {
    window.CONFIG = {
      backends: ['docker', 'ollama'], local: true,
      caps: { platform: 'linux', docker: true, nvidia: true },
      unavailable: {},
      installable: { vllm: {
        info: 'x', steps: [], manual: 'docker pull vllm/vllm-openai:latest',
        via: 'docker', image: 'vllm/vllm-openai:latest', alreadyInstalled: true,
        note: 'n', gpu: 'g' } },
    };
    fillBackends();
    document.getElementById('d-image').value = 'something-else:tag';
    openInstallModal('vllm');
    const hadButton = !!document.getElementById('m-use');
    if (hadButton) document.getElementById('m-use').click();
    const sel = document.getElementById('d-backend');
    const block = document.getElementById('d-docker');
    const modalGone = getComputedStyle(document.getElementById('modal')).display === 'none';
    return {
      hadButton,
      backend: sel.value,
      image: document.getElementById('d-image').value,
      blockShown: block.style.display !== 'none',
      modalGone,
    };
  })()`);
  check("已就绪时给出「用 docker 后端部署」按钮", jumped.hadButton === true);
  check("点它会切到 docker 后端", jumped.backend === 'docker', jumped.backend);
  check("点它会把镜像填成刚装好的那个镜像", jumped.image === 'vllm/vllm-openai:latest', jumped.image);
  check("点它之后 docker 参数区块可见", jumped.blockShown === true);
  check("点它之后弹框关闭", jumped.modalGone === true);

  // 一个装不了的后端不该出现这个跳转按钮（跳过去也跑不起来）。
  const noJump = await run(`(() => {
    window.CONFIG.installable.vllm.alreadyInstalled = true;
    window.CONFIG.installable.vllm.via = 'pip';
    openInstallModal('vllm');
    const has = !!document.getElementById('m-use');
    const hasClose = !!document.getElementById('m-close5');
    closeModal();
    return { has, hasClose };
  })()`);
  check("非 docker 途径的已就绪项不给出跳转按钮，但仍可关闭",
    noJump.has === false && noJump.hasClose === true,
    JSON.stringify(noJump));

  // A not-yet-pulled image must still offer the install button - the ready state
  // above must not swallow the normal case.
  const notReady = await run(`(() => {
    window.CONFIG.installable.vllm.alreadyInstalled = false;
    window.CONFIG.installable.vllm.steps = ['拉取官方镜像'];
    openInstallModal('vllm');
    const hasInstallBtn = !!document.getElementById('m-install');
    const body = document.getElementById('m-body').textContent;
    closeModal();
    return { hasInstallBtn, body };
  })()`);
  check("未拉取时仍然给出「确认安装」按钮", notReady.hasInstallBtn === true);
  check("未拉取时状态是「本机未安装」", notReady.body.indexOf('本机未安装') >= 0);

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

  // 校验被搬进 dockerFields() 之后，必须仍然真的拦得住。
  const badImage = await run(`(async () => {
    document.getElementById('d-image').value = 'evil; rm -rf /';
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.url === '/api/deployments' && c.method === 'POST'),
      log: document.getElementById('d-log').textContent };
  })()`);
  check("非法镜像名提交前被拦", badImage.posted === false && badImage.log.indexOf('镜像') >= 0, badImage.log.slice(0, 40));

  const tooManyVols = await run(`(async () => {
    document.getElementById('d-image').value = 'ok/image:1';
    document.getElementById('d-volumes').value = Array.from({ length: 9 }, (_, i) => '/h' + i + ':/c' + i).join(String.fromCharCode(10));
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.url === '/api/deployments' && c.method === 'POST'),
      log: document.getElementById('d-log').textContent };
  })()`);
  check("数据卷超过 8 条提交前被拦", tooManyVols.posted === false && tooManyVols.log.indexOf('8 条') >= 0, tooManyVols.log.slice(0, 40));

  const tooManyArgs = await run(`(async () => {
    document.getElementById('d-volumes').value = '';
    document.getElementById('d-extra').value = Array.from({ length: 33 }, (_, i) => '--a' + i).join(String.fromCharCode(10));
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.url === '/api/deployments' && c.method === 'POST'),
      log: document.getElementById('d-log').textContent };
  })()`);
  check("额外参数超过 32 项提交前被拦", tooManyArgs.posted === false && tooManyArgs.log.indexOf('32 项') >= 0, tooManyArgs.log.slice(0, 40));

  const nonAbsVol = await run(`(async () => {
    document.getElementById('d-extra').value = '';
    document.getElementById('d-volumes').value = 'relative:/x';
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.url === '/api/deployments' && c.method === 'POST'),
      log: document.getElementById('d-log').textContent };
  })()`);
  check("数据卷非绝对路径提交前被拦", nonAbsVol.posted === false && nonAbsVol.log.indexOf('绝对路径') >= 0, nonAbsVol.log.slice(0, 40));

  const goodAgain = await run(`(async () => {
    document.getElementById('d-volumes').value = '';
    window.__CAP.length = 0;
    await createDeploy();
    return window.__CAP.some((c) => c.url === '/api/deployments' && c.method === 'POST');
  })()`);
  check("清理掉非法值之后又能提交（拦截没有卡死表单）", goodAgain === true);

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
