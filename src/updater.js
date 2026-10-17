// Installed copies update themselves from the newest GitHub Release (published by .github/workflows/build.yml).
const { app } = require("electron");

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.on("error", () => {}); // offline or no release yet: try again next launch
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {
    // Builds without an update channel (e.g. a portable copy) just skip updating.
  }
}

module.exports = { setupAutoUpdates };
