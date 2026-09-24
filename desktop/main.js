"use strict";

const { app, BrowserWindow, shell, nativeTheme } = require("electron");
const { start } = require("./server");

let win = null;
let local = null;

async function createWindow() {
  // Deployments and their logs live in the app data directory, not the repo.
  local = await start(0, { dataDir: app.getPath("userData") });
  win = new BrowserWindow({
    width: 1080,
    height: 900,
    minWidth: 720,
    // The project name lives in the window title bar, so the page itself has
    // no brand header and no separate strip at the top.
    title: "ModelForge",
    // Match the page background so there is no lighter flash or band on launch.
    backgroundColor: "#0b0d10",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(local.url);
  win.once("ready-to-show", () => win.show());
  // Only real web links reach the OS browser. Handing openExternal an
  // unchecked URL would let page content ask the system to open file:// paths or
  // custom schemes, which is a way to launch a local application.
  const openExternally = (url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    shell.openExternal(url);
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  // The window *is* the app, so it must not navigate anywhere else. A link that
  // tries is sent to the OS browser instead of replacing the UI.
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(local.url)) return;
    event.preventDefault();
    openExternally(url);
  });
  win.on("closed", () => {
    win = null;
  });
}

// Two instances share one userData directory, and deployments.json is written
// whole, so a second writer silently drops the first one's records. Hold a
// single-instance lock: a second launch brings the existing window forward and
// exits instead of racing on the file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    // Keep the OS title bar in step with the dark UI instead of following the
    // system appearance, which would give a light bar above a dark page.
    nativeTheme.themeSource = "dark";
    createWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (local) local.close();
    if (process.platform !== "darwin") app.quit();
  });

  // Quitting must not leave llama-server or an ollama pull behind. before-quit
  // is synchronous, so hold the quit until the children are actually reaped.
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !local || !local.stopAll) return;
    event.preventDefault();
    quitting = true;
    local.stopAll().finally(() => app.quit());
  });
}
