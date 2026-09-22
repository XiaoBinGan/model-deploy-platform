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
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    win = null;
  });
}

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

// Quitting must not leave llama-server or an ollama pull behind. before-quit is
// synchronous, so hold the quit until the children are actually reaped.
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !local || !local.stopAll) return;
  event.preventDefault();
  quitting = true;
  local.stopAll().finally(() => app.quit());
});
