// Electron entry point: the Ultimate VMs window and the bridge between its menu (ui/) and the VM library (vms.js).
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const catalog = require("./catalog");
const host = require("./host");
const vms = require("./vms");
const qemu = require("./engines/qemu");
const apple = require("./engines/apple");
const { setupAutoUpdates } = require("./updater");

let win = null;
const send = (channel, data) => win && !win.isDestroyed() && win.webContents.send(channel, data);
vms.onChange((vm) => send("vm-changed", vm));

function engineStatus() {
  return {
    qemu: !!qemu.find("x86_64"),
    apple: apple.available(),
  };
}

// Everything the menu needs to draw itself.
ipcMain.handle("state", () => ({
  host: host.info,
  root: vms.root,
  engines: engineStatus(),
  catalog: catalog.CATALOG.map((entry) => {
    const plan = host.plan(entry);
    if (plan.engine === "apple" && !apple.available()) {
      Object.assign(plan, { engine: null, reason: "The Mac VM helper is missing from this copy of the app. Reinstall Ultimate VMs." });
    }
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family,
      logo: entry.logo,
      blurb: entry.blurb,
      defaults: entry.defaults,
      source: { type: entry.source.type, page: entry.source.page },
      ...plan,
    };
  }),
  vms: vms.list(),
}));

ipcMain.handle("vm-create", (_e, options) => vms.create(options));
ipcMain.handle("vm-prepare", (_e, id) => { vms.prepare(id); });
ipcMain.handle("vm-cancel", (_e, id) => vms.cancel(id));
ipcMain.handle("vm-start", (_e, id) => vms.start(id));
ipcMain.handle("vm-stop", (_e, id, force) => vms.stop(id, force));
ipcMain.handle("vm-update", (_e, id, changes) => vms.update(id, changes));
ipcMain.handle("vm-delete", async (_e, id) => {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Delete this VM?",
    detail: "Its disk and everything installed on it will be permanently erased. Downloaded install discs are kept.",
  });
  if (response === 0) vms.remove(id);
  return response === 0;
});
ipcMain.handle("vm-show-folder", (_e, id) => shell.openPath(vms.folderOf(id)));

ipcMain.handle("pick-iso", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose the install disc",
    properties: ["openFile"],
    filters: [{ name: "Disc images", extensions: ["iso", "img"] }, { name: "All files", extensions: ["*"] }],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("open-url", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle("install-qemu", async () => {
  const result = await qemu.install((text) => send("install-log", text));
  return { ...result, engines: engineStatus() };
});
ipcMain.handle("check-engines", () => engineStatus());
ipcMain.handle("enable-fast-mode", () => qemu.enableFastMode());

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: "Ultimate VMs",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    backgroundColor: "#0c0f17",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("close", async (event) => {
    if (!vms.anyRunning() || win.forceClose) return;
    event.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Keep VMs running", "Close anyway"],
      defaultId: 0,
      message: "VMs are still running",
      detail: "Closing Ultimate VMs leaves them running in their own windows. Shut them down from inside each VM when you're done.",
    });
    if (response === 1) {
      win.forceClose = true;
      win.close();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdates();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
