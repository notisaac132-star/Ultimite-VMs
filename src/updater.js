// Auto-updates from the newest GitHub Release (published by .github/workflows/build.yml).
//
//   Windows installer, Linux AppImage: electron-updater downloads in the background and installs on restart.
//   Mac: the app isn't signed with an Apple Developer ID, which Apple's update mechanism requires, so the
//        app downloads the new .zip itself, checks its SHA-512, and swaps the app bundle on restart.
//   Windows portable: can't replace itself while running, so it offers the download page.
//
// Status goes to the window as { state, version, percent, message }:
//   idle | checking | downloading | ready | latest | manual | error
const { app, net, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = "notisaac132-star/Ultimite-VMs";
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY = 60 * 60 * 1000; // plus a check whenever the window is clicked into, at most every 10 minutes
const MIN_GAP = 10 * 60 * 1000;

let status = { state: "idle", version: null };
let notify = () => {};
let installNow = null; // set once an update is ready
let checking = false;
let lastCheck = 0;

// What happened, for diagnosing "it doesn't update": <app data>/updater.log (see also the version label).
function log(...parts) {
  try {
    const file = path.join(app.getPath("userData"), "updater.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 200_000) fs.rmSync(file);
    fs.appendFileSync(file, `${new Date().toISOString()} v${app.getVersion()} ${parts.join(" ")}\n`);
  } catch {
    // logging must never break updating
  }
}

function set(next) {
  status = { ...status, ...next, current: app.getVersion() };
  log(status.state, status.version || "", status.percent ?? "", status.message || "");
  notify(status);
}

const newer = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// ---------- electron-updater (Windows installer, Linux AppImage) ----------

let autoUpdater = null;
function electronUpdater() {
  if (autoUpdater) return autoUpdater;
  ({ autoUpdater } = require("electron-updater"));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // also installs when the app is simply closed
  autoUpdater.logger = { info: (m) => log("[updater]", m), warn: (m) => log("[updater] warn", m), error: (m) => log("[updater] error", m), debug() {} };
  autoUpdater.on("checking-for-update", () => set({ state: "checking" }));
  autoUpdater.on("update-not-available", () => set({ state: "latest" }));
  autoUpdater.on("update-available", (i) => set({ state: "downloading", version: i.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => set({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => {
    // Silent: the installer has a wizard (it asks which OSes you want), which an update must not show.
    installNow = () => autoUpdater.quitAndInstall(true, true);
    set({ state: "ready", version: i.version });
  });
  autoUpdater.on("error", (err) => set({ state: "error", message: String(err?.message || err).split("\n")[0] }));
  return autoUpdater;
}

// ---------- Mac (self-swap) and Windows portable (download page) ----------

async function latestYml(name) {
  const res = await net.fetch(`${RELEASES}/download/${name}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const text = await res.text();
  const version = text.match(/^version:\s*'?([\d.]+)/m)?.[1];
  // files: - url: <name>  sha512: <base64>
  const files = [...text.matchAll(/-\s*url:\s*'?([^\s']+)'?\s*\n\s*sha512:\s*'?([^\s']+)/g)].map((m) => ({ url: m[1], sha512: m[2] }));
  if (!version) throw new Error("The update info was unreadable.");
  return { version, files };
}

// The running Mac app bundle, e.g. /Applications/Ultimate VMs.app
const macBundle = () => path.resolve(process.execPath, "..", "..", "..");

async function macUpdate() {
  const { version, files } = await latestYml("latest-mac.yml");
  if (!newer(version, app.getVersion())) return set({ state: "latest" });
  const zipInfo = files.find((f) => f.url.endsWith(".zip"));
  if (!zipInfo) throw new Error("The update has no Mac download.");
  const bundle = macBundle();
  if (bundle.startsWith("/Volumes/")) {
    return set({ state: "manual", version, message: "Drag Ultimate VMs into your Applications folder to get automatic updates." });
  }

  set({ state: "downloading", version, percent: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ultimate-vms-update-"));
  const zip = path.join(dir, "update.zip");
  const res = await net.fetch(`${RELEASES}/download/${zipInfo.url}`);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get("content-length") || 0);
  const hash = crypto.createHash("sha512");
  const out = fs.createWriteStream(zip);
  let got = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    out.write(chunk);
    got += chunk.length;
    if (total) set({ percent: Math.round((got / total) * 100) });
  }
  await new Promise((r) => out.end(r));
  if (hash.digest("base64") !== zipInfo.sha512) throw new Error("The update download was damaged. It will try again later.");

  await new Promise((resolve, reject) =>
    execFile("/usr/bin/ditto", ["-x", "-k", zip, path.join(dir, "app")], (err) => (err ? reject(err) : resolve())));
  const fresh = fs.readdirSync(path.join(dir, "app")).find((n) => n.endsWith(".app"));
  if (!fresh) throw new Error("The update didn't contain the app.");

  installNow = () => {
    // After this app quits: replace the bundle, clear the download quarantine and reopen it.
    const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.5; done
rm -rf "$1" && mv "$2" "$1" && xattr -dr com.apple.quarantine "$1"
open "$1"
rm -rf "$3"`;
    spawn("/bin/sh", ["-c", script, "sh", bundle, path.join(dir, "app", fresh), dir], { detached: true, stdio: "ignore" }).unref();
    app.quit();
  };
  set({ state: "ready", version });
}

async function portableCheck() {
  const { version } = await latestYml("latest.yml");
  set(newer(version, app.getVersion())
    ? { state: "manual", version, message: "This is the portable version, so it can't update itself. Download the new one from GitHub." }
    : { state: "latest" });
}

// ---------- Public ----------

// force: the user clicked "check now". Otherwise checks are skipped if one just happened.
async function check({ force = false } = {}) {
  if (!app.isPackaged || checking || status.state === "ready" || status.state === "downloading") return status;
  if (!force && Date.now() - lastCheck < MIN_GAP) return status;
  checking = true;
  lastCheck = Date.now();
  status = { ...status, manual: force };
  try {
    if (process.platform === "darwin") {
      set({ state: "checking" });
      await macUpdate();
    } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
      set({ state: "checking" });
      await portableCheck();
    } else {
      await electronUpdater().checkForUpdates();
    }
  } catch (err) {
    set({ state: "error", message: String(err?.message || err).split("\n")[0] });
  } finally {
    checking = false;
  }
  return status;
}

function setupAutoUpdates(onStatus) {
  notify = onStatus;
  set({ state: app.isPackaged ? "idle" : "dev" });
  if (!app.isPackaged) return;
  log("started, packaged", app.isPackaged, process.env.PORTABLE_EXECUTABLE_DIR ? "(portable)" : "");
  setTimeout(check, 5000);
  setInterval(check, CHECK_EVERY);
}

module.exports = {
  setupAutoUpdates,
  check,
  status: () => status,
  install: () => installNow && installNow(),
  openReleases: () => shell.openExternal(RELEASES),
};
