"use strict";

const { app, BrowserWindow, shell } = require("electron");
const { start } = require("./server");

let win = null;
let local = null;

async function createWindow() {
  // Deployments and their logs live in the app data directory, not the repo.
  local = await start(0, { dataDir: app.getPath("userData") });
  win = new BrowserWindow({
    width: 1360,
    height: 920,
    title: "Model Deploy Platform",
    backgroundColor: "#0f1115",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(local.url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (local) local.close();
  if (process.platform !== "darwin") app.quit();
});
