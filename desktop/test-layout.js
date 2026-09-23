"use strict";

// Layout regression test: load the real page in a real Electron window and walk
// every window width the app allows, failing on any size where the layout
// breaks.
//
// This exists because the layout has already regressed twice in ways that are
// invisible in code review: a 900px cap left 16-inch fullscreen using 52% of the
// window, and switching the hardware tiles to auto-fit made them wrap 3+1 at the
// 720px minimum width. Both are one-line CSS changes; both need a measurement to
// catch.
//
//   node test-layout.js            # against a running control plane
//   MDP_URL=... node test-layout.js
//
// Requires a reachable page. Start the control plane first:
//   cd backend && .venv/bin/python -m uvicorn app.main:app --port 8790

const path = require("node:path");

const URL = process.env.MDP_URL || "http://127.0.0.1:8790";

// The Electron window is created with minWidth 720, so that is the floor.
const MIN_WIDTH = 720;
const MAX_WIDTH = 2600;
const STEP = 40;
// Below this a stat tile starts truncating its own label.
const MIN_TILE = 150;
// Below this a form input is no longer comfortably typeable.
const MIN_FIELD = 180;

const PROBE = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), t: Math.round(r.top) }; };
  const hw = [...document.querySelectorAll(".hw > .hwi")].map(box);
  const rows = {};
  hw.forEach((b) => { rows[b.t] = (rows[b.t] || 0) + 1; });
  const fields = [...document.querySelectorAll("#deploy .form > .field")].map(box);
  const overflow = [...document.querySelectorAll("main *")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
  }).slice(0, 3).map((el) => el.tagName + (el.id ? "#" + el.id : ""));
  return {
    win: innerWidth,
    main: box(document.querySelector("main")).w,
    rows: Object.values(rows),
    minTile: Math.min(...hw.map((b) => b.w)),
    minField: Math.min(...fields.map((b) => b.w)),
    hScroll: document.documentElement.scrollWidth > innerWidth + 1,
    overflow,
  };
})()`;

async function main() {
  let electron;
  try {
    electron = require("electron");
  } catch (e) {
    console.log("  SKIP  需要 electron 运行时；用 electron test-layout.js 启动");
    process.exit(0);
  }

  electron.app.disableHardwareAcceleration();
  await electron.app.whenReady();

  const win = new electron.BrowserWindow({ width: 1080, height: 900, show: false });
  try {
    await win.loadURL(URL);
  } catch (e) {
    console.log("  FAIL  打不开 " + URL + "：" + e.message);
    console.log("        先起控制面：cd backend && .venv/bin/python -m uvicorn app.main:app --port 8790");
    electron.app.exit(1);
    return;
  }
  await new Promise((r) => setTimeout(r, 1200));

  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
    if (ok) pass += 1; else fail += 1;
  };

  // Step by 40 but make sure the sizes that matter are actually sampled: a
  // step that never lands on 1728 would silently skip the 16-inch check.
  const widths = [];
  for (let w = MIN_WIDTH; w <= MAX_WIDTH; w += STEP) widths.push(w);
  for (const must of [1728, 1512, 2560]) if (!widths.includes(must)) widths.push(must);
  widths.sort((a, b) => a - b);

  const broken = [];
  const mainAt = {};
  for (const w of widths) {
    win.setContentSize(w, 900);
    await new Promise((r) => setTimeout(r, 130));
    const m = await win.webContents.executeJavaScript(PROBE);
    const problems = [];
    if (m.hScroll) problems.push("横向滚动");
    if (m.overflow.length) problems.push("元素越界 " + m.overflow.join(","));
    if (m.rows.length > 1 && m.rows.some((n) => n === 1)) problems.push("格子落单 " + m.rows.join("+"));
    if (m.minTile < MIN_TILE) problems.push("格子过窄 " + m.minTile);
    if (m.minField < MIN_FIELD) problems.push("输入框过窄 " + m.minField);
    if (problems.length) broken.push(w + "px: " + problems.join(" | "));
    mainAt[w] = { main: m.main, ratio: m.main / m.win };
  }

  check(MIN_WIDTH + "~" + MAX_WIDTH + " 每个宽度都不破版", broken.length === 0,
    broken.length ? broken.slice(0, 4).join(" ; ") : (widths.length + " 个宽度全部通过"));
  check("窗口变宽时内容跟着变宽（不是固定宽度）",
    mainAt[1280].main > mainAt[720].main && mainAt[1440].main > mainAt[1080].main,
    "720->" + mainAt[720].main + "  1080->" + mainAt[1080].main +
    "  1280->" + mainAt[1280].main + "  1440->" + mainAt[1440].main);
  check("内容宽度跟随窗口到 1440 才封顶",
    mainAt[1440].main === mainAt[1080].main + 360 || mainAt[1440].main >= 1400,
    "1440px 窗口 -> 内容 " + mainAt[1440].main);
  check("16 寸满屏至少用掉 80% 宽度", mainAt[1728].ratio >= 0.8,
    "1728px 窗口用了 " + Math.round(mainAt[1728].ratio * 100) + "%（" + mainAt[1728].main + "px）");

  // The hardware tiles must never wrap to a lone straggler: 4 tiles are 4 or 2+2.
  win.setContentSize(720, 900);
  await new Promise((r) => setTimeout(r, 250));
  const atMin = await win.webContents.executeJavaScript(PROBE);
  check("最小窗口 720px 下硬件格是 2x2", atMin.rows.join("+") === "2+2", atMin.rows.join("+"));

  win.setContentSize(1440, 900);
  await new Promise((r) => setTimeout(r, 250));
  const atWide = await win.webContents.executeJavaScript(PROBE);
  check("1440px 下硬件格是一行 4 个", atWide.rows.join("+") === "4", atWide.rows.join("+"));

  console.log("\n" + pass + " passed, " + fail + " failed");
  electron.app.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
