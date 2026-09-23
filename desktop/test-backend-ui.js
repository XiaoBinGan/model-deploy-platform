"use strict";

// Drives the real page in a real window: an unavailable backend must be
// clickable, must open the install dialog, and must never be left selected.
//
//   electron test-backend-ui.js
//
// Needs the desktop app (or the control plane) serving the page; it reads
// MDP_URL, defaulting to the control plane.

const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();

const URL = process.env.MDP_URL || "http://127.0.0.1:8790";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
  if (ok) pass += 1;
  else fail += 1;
}

const PROBE = `(() => {
  const sel = document.getElementById("d-backend");
  const local = !!(window.CONFIG && window.CONFIG.local);
  const opts = [...sel.options];
  const needs = opts.filter((o) => o.hasAttribute("data-needs-install"));
  return {
    total: opts.length,
    needs: needs.map((o) => o.value),
    ready: opts.filter((o) => !o.hasAttribute("data-needs-install")).map((o) => o.value),
    anyDisabled: opts.some((o) => o.disabled),
    selected: sel.value,
    hint: (document.getElementById("backend-hint") || {}).textContent || "",
    modalOpen: getComputedStyle(document.getElementById("modal")).display !== "none",
    local,
  };
})()`;

// Pick one of the flagged options the way a user would, then report what the
// page did about it.
const PICK = (name) => `(() => {
  const sel = document.getElementById("d-backend");
  const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(name)});
  if (!opt) return { missing: true };
  const before = sel.value;
  sel.selectedIndex = opt.index;
  sel.dispatchEvent(new Event("change"));
  const title = document.getElementById("m-title").textContent;
  const body = document.getElementById("m-body").textContent;
  const actions = document.getElementById("m-actions").textContent;
  return {
    before,
    selectedAfter: sel.value,
    modalOpen: getComputedStyle(document.getElementById("modal")).display !== "none",
    title, body, actions,
    installBtn: !!document.getElementById("m-install"),
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1080, height: 900, show: false });
  try {
    await win.loadURL(URL);
  } catch (e) {
    console.log("  FAIL  打不开 " + URL + "：" + e.message);
    app.exit(1);
    return;
  }
  // The page fetches /api/backends on load and repaints the dropdown from it.
  await sleep(2500);

  const base = await win.webContents.executeJavaScript(PROBE);
  check("下拉列出了全部后端", base.total === 6, "共 " + base.total);
  check("不可用的项被标记而不是被禁用",
    base.needs.length > 0 && !base.anyDisabled,
    "标记 " + base.needs.length + " 个，disabled=" + base.anyDisabled);
  check("下拉停在可用后端上", base.ready.indexOf(base.selected) >= 0, base.selected);
  check("有提示告诉用户可以点", base.hint.length > 0, base.hint.slice(0, 40));
  check("初始没有弹框", base.modalOpen === false);
  console.log("        （" + (base.local ? "桌面端" : "控制面直连") + "模式）");

  // Only the desktop app can install, so only there is there a plan to offer.
  const inst = base.local
    ? base.needs.filter((n) => n !== "vllm" && n !== "sglang" && n !== "transformers")
    : [];
  if (inst.length) {
    const r = await win.webContents.executeJavaScript(PICK(inst[0]));
    check("点可安装项：" + inst[0] + " 打开弹框", r.modalOpen === true);
    check("弹框标题带上后端名", r.title.indexOf(inst[0]) >= 0, r.title);
    check("弹框列出将要执行的步骤", r.body.indexOf("将要执行") >= 0, r.body.slice(0, 60));
    check("弹框提供「确认安装」", r.installBtn === true, r.actions);
    check("下拉没有停在不可用的后端上",
      r.selectedAfter !== inst[0] && base.ready.indexOf(r.selectedAfter) >= 0, r.selectedAfter);
    await win.webContents.executeJavaScript("closeModal()");
    const closed = await win.webContents.executeJavaScript(PROBE);
    check("关闭后弹框消失", closed.modalOpen === false);
  } else if (!base.local) {
    // Direct browser access has no installer; it must say so rather than claim
    // the backend is unrecognised.
    const r = await win.webContents.executeJavaScript(PICK(base.needs[0]));
    check("控制面直连时说清楚装不了要去桌面端",
      r.modalOpen === true && r.body.indexOf("桌面端") >= 0, r.body.slice(0, 60));
    check("控制面直连时不给「确认安装」按钮", r.installBtn === false);
    await win.webContents.executeJavaScript("closeModal()");
  } else {
    console.log("  SKIP  本机没有可自动安装的后端");
  }

  // A backend that cannot be installed here: explain, do not offer a button.
  const blocked = base.needs.filter((n) => !inst.includes(n));
  if (blocked.length) {
    const r = await win.webContents.executeJavaScript(PICK(blocked[0]));
    check("点装不了的项：" + blocked[0] + " 也打开弹框说明原因", r.modalOpen === true);
    check("说明里给出为什么装不了", r.body.indexOf("本机装不了") >= 0, r.body.slice(0, 80));
    check("没有「确认安装」按钮（装不了就不该给按钮）", r.installBtn === false, r.actions);
    check("下拉同样回退", base.ready.indexOf(r.selectedAfter) >= 0, r.selectedAfter);
    await win.webContents.executeJavaScript("closeModal()");
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error("FAILED:", e.message); app.exit(1); });
