// The only functions the menu page can call (see main.js for what each does).
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("vmApi", {
  state: call("state"),
  create: call("vm-create"),
  prepare: call("vm-prepare"),
  cancel: call("vm-cancel"),
  start: call("vm-start"),
  stop: call("vm-stop"),
  update: call("vm-update"),
  remove: call("vm-delete"),
  showFolder: call("vm-show-folder"),
  pickIso: call("pick-iso"),
  openUrl: call("open-url"),
  installQemu: call("install-qemu"),
  checkEngines: call("check-engines"),
  enableFastMode: call("enable-fast-mode"),
  onVmChanged: (fn) => ipcRenderer.on("vm-changed", (_e, vm) => fn(vm)),
  onInstallLog: (fn) => ipcRenderer.on("install-log", (_e, text) => fn(text)),
});
